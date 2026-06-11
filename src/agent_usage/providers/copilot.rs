//! GitHub Copilot usage quota fetcher.
//!
//! Resolves the OAuth token in this order:
//!   1. `COPILOT_TOKEN` env var (explicit override).
//!   2. OpenCode's `auth.json` `github-copilot` entry.
//!   3. Copilot CLI's `~/.config/github-copilot/{apps,hosts}.json`.
//!
//! `GITHUB_TOKEN` / `GH_TOKEN` are intentionally NOT used — those are
//! typically standard GitHub PATs (set by `gh auth`), and the
//! `/copilot_internal/user` endpoint requires the OAuth token issued to
//! the Copilot editor clients. Sending a PAT just produces 401s on every
//! poll while masking that the integration was never wired up.

use super::super::{AcpQuotaProvider, AgentUsage, ExtraInfo, UsageWindow, HTTP_TIMEOUT_COPILOT};
use serde::Deserialize;
use std::collections::HashMap;

const USAGE_URL: &str = "https://api.github.com/copilot_internal/user";
const EDITOR_VERSION: &str = "vscode/1.96.2";
const EDITOR_PLUGIN_VERSION: &str = "copilot-chat/0.26.7";
const USER_AGENT: &str = "GitHubCopilotChat/0.26.7";
const GITHUB_API_VERSION: &str = "2025-04-01";

#[derive(Debug, Deserialize)]
struct QuotaSnapshot {
    percent_remaining: Option<serde_json::Value>,
    entitlement: Option<serde_json::Value>,
    remaining: Option<serde_json::Value>,
}

#[derive(Debug, Deserialize)]
struct QuotaSnapshots {
    premium_interactions: Option<QuotaSnapshot>,
    chat: Option<QuotaSnapshot>,
}

#[derive(Debug, Deserialize)]
struct MonthlyOrLimited {
    completions: Option<serde_json::Value>,
    chat: Option<serde_json::Value>,
}

#[derive(Debug, Deserialize)]
struct CopilotResponse {
    copilot_plan: Option<String>,
    quota_reset_date: Option<String>,
    quota_snapshots: Option<QuotaSnapshots>,
    monthly_quotas: Option<MonthlyOrLimited>,
    limited_user_quotas: Option<MonthlyOrLimited>,
}

pub struct CopilotProvider;

impl AcpQuotaProvider for CopilotProvider {
    fn provider_id(&self) -> &str {
        "copilot"
    }

    fn quota_id(&self, _model: Option<&str>) -> String {
        "copilot".to_string()
    }

    fn fetch_usage(&self, _model: Option<&str>) -> Result<AgentUsage, String> {
        let token = read_token()?;
        fetch_with_token(&token)
    }
}

fn read_token() -> Result<String, String> {
    if let Ok(v) = std::env::var("COPILOT_TOKEN") {
        let t = v.trim();
        if !t.is_empty() {
            return Ok(t.to_string());
        }
    }
    if let Some(t) = super::super::opencode_auth::read_opencode_token("github-copilot") {
        return Ok(t);
    }
    if let Some(t) = read_copilot_cli_token() {
        return Ok(t);
    }
    Err("Copilot OAuth token not found (looked at COPILOT_TOKEN, opencode auth.json, ~/.config/github-copilot/{apps,hosts}.json)".into())
}

/// Reads the OAuth token written by the Copilot CLI / IDE plugins.
///
/// Newer installs use `apps.json`, older ones use `hosts.json`. Both are flat
/// maps keyed like `"github.com:Iv1.xxxx"` whose values include `oauth_token`.
fn read_copilot_cli_token() -> Option<String> {
    let dir = dirs::home_dir()?.join(".config").join("github-copilot");
    for filename in ["apps.json", "hosts.json"] {
        let path = dir.join(filename);
        let Ok(raw) = std::fs::read_to_string(&path) else {
            continue;
        };
        #[derive(Deserialize)]
        struct AppEntry {
            oauth_token: Option<String>,
        }
        let parsed: HashMap<String, AppEntry> = match serde_json::from_str(&raw) {
            Ok(p) => p,
            Err(_) => continue,
        };
        // Prefer entries whose key starts with "github.com" so a self-hosted
        // GHES entry doesn't shadow the public one.
        let mut candidates: Vec<&str> = parsed.keys().map(|s| s.as_str()).collect();
        candidates.sort_by_key(|k| !k.starts_with("github.com"));
        for key in candidates {
            if let Some(token) = parsed.get(key).and_then(|e| e.oauth_token.as_deref()) {
                let t = token.trim();
                if !t.is_empty() {
                    return Some(t.to_string());
                }
            }
        }
    }
    None
}

pub(crate) fn fetch_with_token(token: &str) -> Result<AgentUsage, String> {
    let agent = ureq::AgentBuilder::new()
        .timeout(HTTP_TIMEOUT_COPILOT)
        .build();
    let resp = agent
        .get(USAGE_URL)
        // Copilot uses `token <TOKEN>`, not `Bearer`.
        .set("Authorization", &format!("token {}", token.trim()))
        .set("Accept", "application/json")
        .set("Editor-Version", EDITOR_VERSION)
        .set("Editor-Plugin-Version", EDITOR_PLUGIN_VERSION)
        .set("User-Agent", USER_AGENT)
        .set("X-Github-Api-Version", GITHUB_API_VERSION)
        .call()
        .map_err(|e| format!("usage api call failed: {}", e))?;

    let body: CopilotResponse = resp
        .into_json()
        .map_err(|e| format!("parse usage response: {}", e))?;

    let premium_remaining = percent_remaining(
        body.quota_snapshots
            .as_ref()
            .and_then(|q| q.premium_interactions.as_ref()),
    )
    .or_else(|| {
        derive_from_monthly_and_limited(
            body.monthly_quotas
                .as_ref()
                .and_then(|m| m.completions.as_ref()),
            body.limited_user_quotas
                .as_ref()
                .and_then(|m| m.completions.as_ref()),
        )
    });
    let chat_remaining = percent_remaining(
        body.quota_snapshots.as_ref().and_then(|q| q.chat.as_ref()),
    )
    .or_else(|| {
        derive_from_monthly_and_limited(
            body.monthly_quotas.as_ref().and_then(|m| m.chat.as_ref()),
            body.limited_user_quotas
                .as_ref()
                .and_then(|m| m.chat.as_ref()),
        )
    });

    if premium_remaining.is_none() && chat_remaining.is_none() {
        return Err("no usable Copilot quota data".into());
    }

    let mut usage = AgentUsage::new("github-copilot-cli");
    usage.plan = Some(format_plan(body.copilot_plan.as_deref()));

    let resets_at = body.quota_reset_date.clone();
    let resets_in_seconds = resets_at.as_deref().and_then(iso_date_to_seconds_remaining);

    // Copilot quotas are monthly. Approximating as 30 days for the safe-guard
    // line — close enough for an "on pace" indicator.
    let monthly_secs: i64 = 30 * 86400;

    if let Some(pct) = premium_remaining {
        usage.windows.push(UsageWindow {
            label: "Premium".to_string(),
            percentage_remaining: pct,
            resets_at: resets_at.clone(),
            resets_in_seconds,
            total_window_seconds: Some(monthly_secs),
        });
    }
    if let Some(pct) = chat_remaining {
        usage.windows.push(UsageWindow {
            label: "Chat".to_string(),
            percentage_remaining: pct,
            resets_at: resets_at.clone(),
            resets_in_seconds,
            total_window_seconds: Some(monthly_secs),
        });
    }

    if let Some(date) = resets_at {
        usage.extras.push(ExtraInfo {
            label: "Resets".to_string(),
            value: date,
        });
    }

    usage.finalize().ok_or_else(|| "no usage windows".into())
}

fn to_f64(value: Option<&serde_json::Value>) -> Option<f64> {
    let v = value?;
    if let Some(n) = v.as_f64() {
        if n.is_finite() {
            return Some(n);
        }
    }
    if let Some(s) = v.as_str() {
        if let Ok(n) = s.parse::<f64>() {
            if n.is_finite() {
                return Some(n);
            }
        }
    }
    None
}

fn clamp_percent(value: f64) -> f32 {
    value.clamp(0.0, 100.0).round() as f32
}

fn percent_remaining(snapshot: Option<&QuotaSnapshot>) -> Option<f32> {
    let s = snapshot?;
    if let Some(pct) = to_f64(s.percent_remaining.as_ref()) {
        return Some(clamp_percent(pct));
    }
    let entitlement = to_f64(s.entitlement.as_ref())?;
    let remaining = to_f64(s.remaining.as_ref())?;
    if entitlement <= 0.0 {
        return None;
    }
    Some(clamp_percent((remaining / entitlement) * 100.0))
}

/// Matches the reference: `limited_user_quotas` behaves like the remaining
/// amount, not the used amount, so percent_remaining = limited / monthly.
fn derive_from_monthly_and_limited(
    monthly: Option<&serde_json::Value>,
    limited: Option<&serde_json::Value>,
) -> Option<f32> {
    let m = to_f64(monthly)?;
    let l = to_f64(limited)?;
    if m <= 0.0 {
        return None;
    }
    Some(clamp_percent((l / m) * 100.0))
}

fn format_plan(plan: Option<&str>) -> String {
    let raw = plan.unwrap_or("").trim();
    if raw.is_empty() {
        return "Copilot".to_string();
    }
    let parts: Vec<String> = raw
        .split(|c: char| c == '_' || c == '-' || c.is_whitespace())
        .filter(|s| !s.is_empty())
        .map(|s| {
            let mut chars = s.chars();
            match chars.next() {
                Some(c) => {
                    c.to_uppercase().collect::<String>() + &chars.as_str().to_ascii_lowercase()
                }
                None => String::new(),
            }
        })
        .collect();
    if parts.is_empty() {
        "Copilot".to_string()
    } else {
        parts.join(" ")
    }
}

/// Copilot returns `quota_reset_date` as a plain date like "2026-05-01".
/// Treat as 00:00:00 UTC and compute seconds to that instant.
fn iso_date_to_seconds_remaining(date: &str) -> Option<i64> {
    // Try full RFC3339 first, then plain yyyy-mm-dd.
    if let Ok(ts) = chrono::DateTime::parse_from_rfc3339(date) {
        let now = chrono::Utc::now().timestamp();
        return Some((ts.timestamp() - now).max(0));
    }
    let dt = chrono::NaiveDate::parse_from_str(date, "%Y-%m-%d").ok()?;
    let midnight = dt.and_hms_opt(0, 0, 0)?.and_utc().timestamp();
    let now = chrono::Utc::now().timestamp();
    Some((midnight - now).max(0))
}

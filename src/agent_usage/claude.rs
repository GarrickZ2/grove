//! Claude Code usage quota fetcher.
//!
//! Credential lookup strategy (mirrors the reference Raycast extension):
//!   1. `~/.claude/.credentials.json` (plain JSON or hex-encoded JSON)
//!   2. macOS login keychain via `security find-generic-password`, service
//!      name `"Claude Code-credentials"`
//!
//! Calls `https://api.anthropic.com/api/oauth/usage` with the access token.
//! We do NOT refresh expired tokens (that would require writing back to the
//! credentials store). If the token is expired or missing required scopes,
//! the caller treats the agent as unavailable.

use super::{
    clamp_percent, iso_to_seconds_remaining, AgentUsage, ExtraInfo, UsageWindow,
    HTTP_TIMEOUT_CLAUDE,
};
use serde::Deserialize;
use std::fs;
use std::process::{Command, Stdio};

const CREDENTIALS_PATH: &str = ".claude/.credentials.json";
const USAGE_URL: &str = "https://api.anthropic.com/api/oauth/usage";
#[cfg(target_os = "macos")]
const KEYCHAIN_SERVICE: &str = "Claude Code-credentials";
const REQUIRED_SCOPE: &str = "user:profile";
const CLAUDE_CODE_UA: &str = "claude-code/2.1.92";

#[derive(Debug, Deserialize)]
struct CredentialsFile {
    #[serde(rename = "claudeAiOauth")]
    claude_ai_oauth: Option<OAuthBlock>,
}

#[derive(Debug, Deserialize)]
struct OAuthBlock {
    #[serde(rename = "accessToken")]
    access_token: Option<String>,
    #[serde(default)]
    scopes: Vec<String>,
    #[serde(rename = "rateLimitTier", default)]
    rate_limit_tier_camel: Option<String>,
    #[serde(rename = "rate_limit_tier", default)]
    rate_limit_tier_snake: Option<String>,
    #[serde(rename = "subscriptionType", default)]
    subscription_type_camel: Option<String>,
    #[serde(rename = "subscription_type", default)]
    subscription_type_snake: Option<String>,
}

impl OAuthBlock {
    fn rate_limit_tier(&self) -> Option<&str> {
        self.rate_limit_tier_camel
            .as_deref()
            .or(self.rate_limit_tier_snake.as_deref())
    }
    fn subscription_type(&self) -> Option<&str> {
        self.subscription_type_camel
            .as_deref()
            .or(self.subscription_type_snake.as_deref())
    }
}

#[derive(Debug, Deserialize)]
struct OAuthUsageResponse {
    five_hour: Option<OAuthWindow>,
    seven_day: Option<OAuthWindow>,
    seven_day_opus: Option<OAuthWindow>,
    seven_day_sonnet: Option<OAuthWindow>,
    extra_usage: Option<OAuthExtraUsage>,
}

#[derive(Debug, Deserialize)]
struct OAuthWindow {
    utilization: Option<f32>,
    resets_at: Option<String>,
}

#[derive(Debug, Deserialize)]
struct OAuthExtraUsage {
    is_enabled: Option<bool>,
    /// cents
    monthly_limit: Option<f64>,
    /// cents
    used_credits: Option<f64>,
    currency: Option<String>,
}

struct Credentials {
    access_token: String,
    rate_limit_tier: Option<String>,
    subscription_type: Option<String>,
}

pub fn fetch() -> Result<AgentUsage, String> {
    let creds = read_credentials()?;
    let plan = infer_plan(
        creds.rate_limit_tier.as_deref(),
        creds.subscription_type.as_deref(),
    );

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

    // The reference requires `five_hour` to exist (otherwise parse_error).
    let five_hour = body
        .five_hour
        .as_ref()
        .ok_or("missing five_hour in usage response")?;
    if five_hour.utilization.is_none() {
        return Err("five_hour.utilization missing".into());
    }

    let mut usage = AgentUsage::new("claude");
    usage.plan = Some(plan);

    push_window(&mut usage.windows, "5h limit", body.five_hour.as_ref());
    push_window(&mut usage.windows, "7d limit", body.seven_day.as_ref());
    push_window(
        &mut usage.windows,
        "7d Sonnet",
        body.seven_day_sonnet.as_ref(),
    );
    push_window(&mut usage.windows, "7d Opus", body.seven_day_opus.as_ref());

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

fn push_window(out: &mut Vec<UsageWindow>, label: &str, window: Option<&OAuthWindow>) {
    let Some(w) = window else { return };
    let Some(util) = w.utilization else { return };
    let remaining = clamp_percent(100.0 - util);
    let resets_in_seconds = w.resets_at.as_deref().and_then(iso_to_seconds_remaining);
    out.push(UsageWindow {
        label: label.to_string(),
        percentage_remaining: remaining,
        resets_at: w.resets_at.clone(),
        resets_in_seconds,
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

// ---------- credential resolution ----------

fn read_credentials() -> Result<Credentials, String> {
    // Strategy 1: macOS login keychain. This most closely matches Claude
    // Code itself and avoids preferring a stale on-disk token over the
    // active credential stored by the desktop client.
    #[cfg(target_os = "macos")]
    {
        if let Some(value) = read_keychain_password(KEYCHAIN_SERVICE) {
            if let Some(c) = parse_credential_text(&value) {
                return Ok(c);
            }
        }
    }

    // Strategy 2: credentials file
    if let Some(home) = dirs::home_dir() {
        let path = home.join(CREDENTIALS_PATH);
        if path.exists() {
            if let Ok(text) = fs::read_to_string(&path) {
                if let Some(c) = parse_credential_text(&text) {
                    return Ok(c);
                }
            }
        }
    }

    Err("Claude credentials not found (file or keychain)".into())
}

fn parse_credential_text(text: &str) -> Option<Credentials> {
    let parsed: CredentialsFile = serde_json::from_str(text)
        .ok()
        .or_else(|| try_decode_hex_json(text))?;
    let oauth = parsed.claude_ai_oauth?;
    let raw_token = oauth.access_token.as_deref().unwrap_or("").trim();
    if raw_token.is_empty() {
        return None;
    }
    let access_token = normalize_bearer(raw_token);
    if !oauth.scopes.iter().any(|s| s == REQUIRED_SCOPE) {
        // Missing user:profile scope — reference treats this as an error.
        return None;
    }
    Some(Credentials {
        access_token,
        rate_limit_tier: oauth.rate_limit_tier().map(|s| s.to_string()),
        subscription_type: oauth.subscription_type().map(|s| s.to_string()),
    })
}

fn normalize_bearer(token: &str) -> String {
    let t = token.trim();
    if t.len() >= 7 && t[..7].eq_ignore_ascii_case("bearer ") {
        t[7..].trim().to_string()
    } else {
        t.to_string()
    }
}

fn try_decode_hex_json(text: &str) -> Option<CredentialsFile> {
    let mut hex = text.trim().to_string();
    if hex.starts_with("0x") || hex.starts_with("0X") {
        hex = hex[2..].to_string();
    }
    if hex.is_empty() || !hex.len().is_multiple_of(2) || !hex.chars().all(|c| c.is_ascii_hexdigit())
    {
        return None;
    }
    let bytes = (0..hex.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&hex[i..i + 2], 16))
        .collect::<Result<Vec<u8>, _>>()
        .ok()?;
    let decoded = String::from_utf8(bytes).ok()?;
    serde_json::from_str(&decoded).ok()
}

#[cfg(target_os = "macos")]
fn read_keychain_password(service: &str) -> Option<String> {
    let output = Command::new("security")
        .arg("find-generic-password")
        .arg("-s")
        .arg(service)
        .arg("-w")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let value = String::from_utf8(output.stdout).ok()?.trim().to_string();
    if value.is_empty() {
        None
    } else {
        Some(value)
    }
}

//! Agent usage quota fetching for Claude Code / Codex / Gemini.
//!
//! Reads local credential files (OAuth tokens) and, for Claude Code on macOS,
//! also falls back to the login keychain. We never refresh tokens and never
//! write credentials back. If a token is expired or any upstream call fails,
//! the function returns `None` and the frontend hides the quota badge.
//!
//! Results are cached in memory per-agent with a 60s TTL. Callers can pass
//! `force = true` to bypass the cache (the result is still written back).

pub mod claude;
pub mod codex;
pub mod gemini;

use once_cell::sync::Lazy;
use serde::Serialize;
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// Cache TTL for agent usage data.
const CACHE_TTL: Duration = Duration::from_secs(60);

/// Per-agent HTTP timeouts for outbound upstream calls. Matches the reference
/// Raycast extension's values (Gemini's two-step flow is slightly slower).
pub(crate) const HTTP_TIMEOUT_CLAUDE: Duration = Duration::from_secs(10);
pub(crate) const HTTP_TIMEOUT_CODEX: Duration = Duration::from_secs(10);
pub(crate) const HTTP_TIMEOUT_GEMINI: Duration = Duration::from_secs(15);

/// A single rate-limit window reported to the frontend.
#[derive(Debug, Clone, Serialize)]
pub struct UsageWindow {
    /// Human-readable label, e.g. "5h limit", "7d limit", "Gemini 2.5 Pro".
    pub label: String,
    /// Remaining percentage (0.0 - 100.0).
    pub percentage_remaining: f32,
    /// ISO 8601 timestamp at which the window resets, if known.
    pub resets_at: Option<String>,
    /// Seconds until reset, if known (fallback when `resets_at` is unavailable).
    pub resets_in_seconds: Option<i64>,
}

/// An extra info row for the tooltip (credits balance, account email, tier, …).
#[derive(Debug, Clone, Serialize)]
pub struct ExtraInfo {
    pub label: String,
    pub value: String,
}

/// Unified agent usage payload returned to the frontend.
#[derive(Debug, Clone, Serialize)]
pub struct AgentUsage {
    /// "claude" | "codex" | "gemini"
    pub agent: String,
    /// Plan or tier name, e.g. "Claude Max", "ChatGPT Pro", "Gemini Paid".
    pub plan: Option<String>,
    /// The smallest `percentage_remaining` across all windows (the most
    /// constrained quota). Frontend display policy can choose a different
    /// window, but the backend keeps this field as a pure aggregate.
    pub percentage_remaining: f32,
    /// All windows — shown as rows in the badge's hover tooltip.
    pub windows: Vec<UsageWindow>,
    /// Additional informational rows for the tooltip (credits, email, etc.).
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub extras: Vec<ExtraInfo>,
}

impl AgentUsage {
    pub fn new(agent: impl Into<String>) -> Self {
        Self {
            agent: agent.into(),
            plan: None,
            percentage_remaining: 100.0,
            windows: Vec::new(),
            extras: Vec::new(),
        }
    }

    /// Finalize: round each window's percentage, then compute the minimum.
    /// Rounding happens on the backend so the frontend's displayed number
    /// and its color-threshold check stay in sync — e.g. 49.6 becomes 50
    /// (green), not "50% in amber". Returns `None` if there are zero windows.
    pub fn finalize(mut self) -> Option<Self> {
        if self.windows.is_empty() {
            return None;
        }
        for w in &mut self.windows {
            w.percentage_remaining = w.percentage_remaining.clamp(0.0, 100.0).round();
        }
        let min = self
            .windows
            .iter()
            .map(|w| w.percentage_remaining)
            .fold(f32::INFINITY, f32::min);
        self.percentage_remaining = min.clamp(0.0, 100.0);
        Some(self)
    }
}

#[derive(Clone)]
struct CacheEntry {
    usage: AgentUsage,
    fetched_at: Instant,
}

static CACHE: Lazy<Mutex<HashMap<String, CacheEntry>>> = Lazy::new(|| Mutex::new(HashMap::new()));

/// How long a stale cache entry is kept alive when fresh fetches keep
/// failing (429, network timeout, etc.). This avoids hiding the badge
/// just because the upstream API is temporarily unhappy.
const STALE_TTL: Duration = Duration::from_secs(300);

/// Fetch usage for the given agent ("claude" / "codex" / "gemini").
///
/// When `force` is false, a cached entry newer than `CACHE_TTL` is returned
/// without hitting the upstream API. When `force` is true, the cache is
/// bypassed for the fetch but the result is still written back.
///
/// On transient failures (429, timeout, network errors), a stale cache
/// entry up to `STALE_TTL` old is returned so the badge doesn't flicker
/// off just because one refresh failed. Permanent failures (missing
/// credentials, expired tokens) never reach the cache because they fail
/// before we have any data, so the badge stays hidden as designed.
pub async fn fetch_usage(agent: &str, force: bool) -> Option<AgentUsage> {
    if !force {
        if let Some(cached) = get_fresh_cached(agent) {
            return Some(cached);
        }
    }

    let agent_owned = agent.to_string();
    let fetched = tokio::task::spawn_blocking(move || fetch_blocking(&agent_owned))
        .await
        .ok()
        .flatten();

    match fetched {
        Some(usage) => {
            put_cached(agent, usage.clone());
            Some(usage)
        }
        None => {
            // Fresh fetch failed — fall back to a stale cache entry if one
            // exists and isn't too old. This covers transient errors (429,
            // network hiccups) without showing stale data forever.
            get_stale_cached(agent)
        }
    }
}

/// Return cached entry only if it's within the normal TTL (fresh).
fn get_fresh_cached(agent: &str) -> Option<AgentUsage> {
    let guard = CACHE.lock().ok()?;
    let entry = guard.get(agent)?;
    if entry.fetched_at.elapsed() < CACHE_TTL {
        Some(entry.usage.clone())
    } else {
        None
    }
}

/// Return cached entry even if it's past the normal TTL, as long as it's
/// within the extended stale window. Used as a fallback when a fresh fetch
/// fails due to transient errors (429, timeout).
fn get_stale_cached(agent: &str) -> Option<AgentUsage> {
    let guard = CACHE.lock().ok()?;
    let entry = guard.get(agent)?;
    if entry.fetched_at.elapsed() < STALE_TTL {
        Some(entry.usage.clone())
    } else {
        None
    }
}

fn put_cached(agent: &str, usage: AgentUsage) {
    if let Ok(mut guard) = CACHE.lock() {
        guard.insert(
            agent.to_string(),
            CacheEntry {
                usage,
                fetched_at: Instant::now(),
            },
        );
    }
}

/// Dispatch to the agent-specific blocking fetcher.
///
/// Errors are intentionally swallowed without logging: this feature is
/// designed to be "invisible on failure" (the frontend hides the badge on
/// 404), and a failed fetch happens every minute while credentials are
/// missing — logging would spam stderr.
fn fetch_blocking(agent: &str) -> Option<AgentUsage> {
    match agent {
        "claude" => claude::fetch().ok(),
        "codex" => codex::fetch().ok(),
        "gemini" => gemini::fetch().ok(),
        _ => None,
    }
}

/// Convert an ISO 8601 timestamp into seconds remaining from "now". Returns
/// `None` if the string cannot be parsed.
pub(crate) fn iso_to_seconds_remaining(iso: &str) -> Option<i64> {
    let target = chrono::DateTime::parse_from_rfc3339(iso).ok()?;
    let now = chrono::Utc::now();
    Some((target.with_timezone(&chrono::Utc) - now).num_seconds())
}

/// Clamp a percentage to `[0, 100]` and round to a whole number.
pub(crate) fn clamp_percent(v: f32) -> f32 {
    if !v.is_finite() {
        return 0.0;
    }
    v.clamp(0.0, 100.0).round()
}

//! ACP registry cache.
//!
//! Fetches the official ACP agent registry from
//! https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json and
//! caches it under `~/.grove/registry/registry.json` with a tiny meta sidecar.
//!
//! Refresh policy:
//!   - On startup grove kicks off a background refresh if the cache is older
//!     than `STALE_AFTER`.
//!   - Manual refresh available via `POST /api/v1/agents/marketplace/refresh`.
//!   - When refresh fails we fall back to the existing cache (offline-safe).
//!
//! We deliberately do NOT block the marketplace API on a fresh fetch — stale
//! data is always better than no data. The merge layer can still show
//! installed/auto-detected agents from supplement even with zero cached
//! registry entries.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::time::Duration;

use crate::error::Result;

const REGISTRY_URL: &str = "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json";
const STALE_AFTER: Duration = Duration::from_secs(60 * 60 * 24); // 24h
const FETCH_TIMEOUT: Duration = Duration::from_secs(15);

/// A single registry agent entry. We mirror only the fields we use; the rest
/// passes through as opaque JSON via #[serde(flatten)] is intentionally
/// avoided — we don't want to silently propagate unknown distribution kinds.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RegistryAgent {
    pub id: String,
    pub name: String,
    pub version: String,
    #[serde(default)]
    pub description: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repository: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub website: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub authors: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub license: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    #[serde(default)]
    pub distribution: Distribution,
}

/// Tagged distribution methods. Each key may or may not be present; an entry
/// with all-empty distribution still appears (just can't be installed).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Distribution {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub npx: Option<NpxDistribution>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub uvx: Option<UvxDistribution>,
    /// Per-platform binary targets keyed by `<os>-<arch>` (e.g. `darwin-aarch64`).
    #[serde(default, skip_serializing_if = "std::collections::HashMap::is_empty")]
    pub binary: std::collections::HashMap<String, BinaryTarget>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NpxDistribution {
    pub package: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub args: Vec<String>,
    #[serde(default, skip_serializing_if = "std::collections::HashMap::is_empty")]
    pub env: std::collections::HashMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UvxDistribution {
    pub package: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub args: Vec<String>,
    #[serde(default, skip_serializing_if = "std::collections::HashMap::is_empty")]
    pub env: std::collections::HashMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BinaryTarget {
    pub archive: String,
    pub cmd: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub args: Vec<String>,
    #[serde(default, skip_serializing_if = "std::collections::HashMap::is_empty")]
    pub env: std::collections::HashMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RegistryDocument {
    pub version: String,
    pub agents: Vec<RegistryAgent>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CacheMeta {
    pub fetched_at: DateTime<Utc>,
    pub source_url: String,
}

fn registry_dir() -> PathBuf {
    super::grove_dir().join("registry")
}

fn registry_path() -> PathBuf {
    registry_dir().join("registry.json")
}

fn meta_path() -> PathBuf {
    registry_dir().join("meta.json")
}

/// Read the cached registry document. Returns `Ok(None)` when no cache
/// exists yet (first launch before any refresh succeeded).
pub fn load_cached() -> Result<Option<RegistryDocument>> {
    let path = registry_path();
    if !path.exists() {
        return Ok(None);
    }
    let bytes = std::fs::read(&path)?;
    let doc: RegistryDocument = serde_json::from_slice(&bytes)
        .map_err(|e| crate::error::GroveError::storage(format!("registry cache parse: {}", e)))?;
    Ok(Some(doc))
}

/// Read cache meta — timestamp of last successful fetch.
pub fn load_meta() -> Result<Option<CacheMeta>> {
    let path = meta_path();
    if !path.exists() {
        return Ok(None);
    }
    let bytes = std::fs::read(&path)?;
    let meta: CacheMeta = serde_json::from_slice(&bytes)
        .map_err(|e| crate::error::GroveError::storage(format!("registry meta parse: {}", e)))?;
    Ok(Some(meta))
}

fn write_cache(doc: &RegistryDocument) -> Result<()> {
    let dir = registry_dir();
    std::fs::create_dir_all(&dir)?;
    let bytes = serde_json::to_vec_pretty(doc).map_err(|e| {
        crate::error::GroveError::storage(format!("registry cache serialize: {}", e))
    })?;
    std::fs::write(registry_path(), bytes)?;
    let meta = CacheMeta {
        fetched_at: Utc::now(),
        source_url: REGISTRY_URL.to_string(),
    };
    let meta_bytes = serde_json::to_vec_pretty(&meta).map_err(|e| {
        crate::error::GroveError::storage(format!("registry meta serialize: {}", e))
    })?;
    std::fs::write(meta_path(), meta_bytes)?;
    Ok(())
}

/// Cache is considered stale once it's older than `STALE_AFTER`. Missing cache
/// is also "stale" (needs refresh). Errors reading meta are treated as stale.
pub fn is_stale() -> bool {
    match load_meta() {
        Ok(Some(meta)) => {
            let age = Utc::now().signed_duration_since(meta.fetched_at);
            age.to_std().map(|d| d >= STALE_AFTER).unwrap_or(true)
        }
        _ => true,
    }
}

/// Fetch the registry from the CDN and write to the cache. Never partially
/// updates — either the whole doc lands or the cache stays as it was.
pub async fn refresh() -> Result<RegistryDocument> {
    let client = reqwest::Client::builder()
        .timeout(FETCH_TIMEOUT)
        .build()
        .map_err(|e| crate::error::GroveError::storage(format!("reqwest build: {}", e)))?;
    let resp = client
        .get(REGISTRY_URL)
        .send()
        .await
        .map_err(|e| crate::error::GroveError::storage(format!("registry fetch: {}", e)))?;
    if !resp.status().is_success() {
        return Err(crate::error::GroveError::storage(format!(
            "registry fetch HTTP {}",
            resp.status()
        )));
    }
    let bytes = resp
        .bytes()
        .await
        .map_err(|e| crate::error::GroveError::storage(format!("registry body: {}", e)))?;
    let doc: RegistryDocument = serde_json::from_slice(&bytes)
        .map_err(|e| crate::error::GroveError::storage(format!("registry parse: {}", e)))?;
    write_cache(&doc)?;
    Ok(doc)
}

/// Returns cached registry (if any) without triggering a refresh.
pub fn get() -> RegistryDocument {
    load_cached().ok().flatten().unwrap_or(RegistryDocument {
        version: "0.0.0".to_string(),
        agents: Vec::new(),
    })
}

/// Background-refresh helper. Fire-and-forget; logs but doesn't propagate
/// errors (offline-safe). Caller should spawn this on a tokio runtime.
pub async fn refresh_if_stale() {
    if !is_stale() {
        return;
    }
    if let Err(e) = refresh().await {
        eprintln!("[agent_registry] background refresh failed: {}", e);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_real_registry_snapshot() {
        // Minimal snapshot mirroring the real CDN payload shape.
        let json = r#"{
            "version": "1.0.0",
            "agents": [
                {
                    "id": "claude-acp",
                    "name": "Claude Code",
                    "version": "0.36.1",
                    "description": "Claude via ACP",
                    "icon": "https://example/icon.svg",
                    "distribution": {
                        "npx": {
                            "package": "@agentclientprotocol/claude-agent-acp@0.36.1"
                        }
                    }
                },
                {
                    "id": "amp-acp",
                    "name": "Amp",
                    "version": "0.7.0",
                    "distribution": {
                        "binary": {
                            "darwin-aarch64": {
                                "archive": "https://example/amp-darwin-aarch64.tar.gz",
                                "cmd": "./amp-acp"
                            }
                        }
                    }
                }
            ]
        }"#;
        let doc: RegistryDocument = serde_json::from_str(json).unwrap();
        assert_eq!(doc.agents.len(), 2);
        assert!(doc.agents[0].distribution.npx.is_some());
        assert_eq!(doc.agents[1].distribution.binary.len(), 1);
    }
}

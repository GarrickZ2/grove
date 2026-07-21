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
    /// grove-only: when present, the agent's local binary is launched via
    /// PTY using this argv contract instead of stdio ACP. Absent on every
    /// real registry entry; set on the synthetic `claude-acp` entry by
    /// `inject_grove_supplements`. Drives:
    ///   - Auto-scan probes `cmd` as an additional PATH candidate.
    ///   - Chat creation flips `chat.launch_mode = "terminal"` when the
    ///     selected channel is External AND this field is present.
    ///   - `agent_pty.rs` reads the argv contract here.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub terminal_launch: Option<TerminalLaunch>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TerminalLaunch {
    /// Bare binary name (e.g. `"claude"`). Probed by auto-scan; resolved
    /// path becomes `installations[External].install_path`.
    pub cmd: String,
    /// Argv flag introducing a fresh session UUID. (`--session-id` for claude.)
    pub session_id_arg: String,
    /// Argv flag resuming an existing session UUID. (`--resume` for claude.)
    pub resume_arg: String,
    /// Argv flag pointing at the MCP config file grove writes per chat.
    /// (`--mcp-config` for claude.) The file format itself is fixed
    /// (`mcpServers` JSON); only the flag name is configurable here.
    pub mcp_config_arg: String,
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
    /// Legacy field — unused since v2.6. Kept on the struct so older
    /// `~/.grove/registry/registry.json` caches still deserialize.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub local: Option<LocalDistribution>,
}

/// Local-probe metadata. Mirrors the shape of an installed binary
/// without going through grove's installer.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LocalDistribution {
    /// Ordered candidates, first PATH hit wins. Always non-empty.
    pub candidates: Vec<String>,
    /// Per-platform binary args (e.g. `["--acp"]` for `claude-agent-acp`).
    /// Optional — defaults to no args.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub args: Vec<String>,
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

/// Returns the cached registry document with grove's two synthetic
/// entries (`trae`, `traex`) always appended. The synthetics make the
/// two internal ByteDance binaries first-class citizens of the
/// Marketplace catalog regardless of whether they are on the user's
/// PATH — install state is tracked by
/// `installed_agents::auto_scan_path_binaries()`, which walks every
/// registry agent (Trae/TraeX included) and writes / removes External
/// `installed_agents` channels based on PATH presence.
///
/// This is THE only place trae / traex specific data lives in the
/// catalog — the launch command (`traecli` / `traex`) and ACP argv
/// (`["acp", "serve"]`) ride on `RegistryAgent.distribution.binary`,
/// and the rest of the codebase treats them as ordinary registry
/// entries.
pub fn get() -> RegistryDocument {
    let mut doc = load_cached().ok().flatten().unwrap_or(RegistryDocument {
        version: "0.0.0".to_string(),
        agents: Vec::new(),
    });
    inject_trae_and_traex_entries(&mut doc);
    inject_grove_supplements(&mut doc);
    doc
}

fn has_onboarding_contract(doc: &RegistryDocument) -> bool {
    crate::storage::curated_agents::onboarding_agent_ids()
        .iter()
        .all(|id| {
            doc.agents
                .iter()
                .find(|agent| agent.id == *id)
                .is_some_and(|agent| agent.distribution.npx.is_some())
        })
}

/// Resolve the registry snapshot used by startup auto install.
///
/// Cache-first: a complete cached contract is immediately usable. If the
/// cache is absent, corrupt, or predates one of the onboarding agents, perform
/// one blocking network refresh before startup proceeds. This keeps the
/// registry as the source of package/version metadata while making auto
/// install a checked prerequisite instead of a best-effort background task.
pub async fn get_for_auto_install() -> Result<RegistryDocument> {
    let cached = get();
    if has_onboarding_contract(&cached) {
        return Ok(cached);
    }

    let mut fresh = refresh().await?;
    inject_trae_and_traex_after_refresh(&mut fresh);
    if !has_onboarding_contract(&fresh) {
        let missing = crate::storage::curated_agents::onboarding_agent_ids()
            .iter()
            .filter(|id| {
                fresh
                    .agents
                    .iter()
                    .find(|agent| agent.id.as_str() == **id)
                    .is_none_or(|agent| agent.distribution.npx.is_none())
            })
            .copied()
            .collect::<Vec<_>>()
            .join(", ");
        return Err(crate::error::GroveError::storage(format!(
            "ACP registry is missing onboarding npx distributions: {}",
            missing
        )));
    }
    Ok(fresh)
}

/// Add Trae + TraeX synthetics and grove-only supplements after a fresh
/// refresh has replaced the document. `get()` does this automatically.
pub fn inject_trae_and_traex_after_refresh(doc: &mut RegistryDocument) {
    inject_trae_and_traex_entries(doc);
    inject_grove_supplements(doc);
}

/// grove-only data overlays on top of the upstream ACP registry. This is
/// the ONE place agent-specific knowledge lives — code elsewhere is
/// data-driven off whatever this writes.
///
/// Currently patches:
///   - `claude-acp`: adds a `terminal_launch` config describing how to
///     drive the bare `claude` CLI via PTY (session-id + resume + mcp
///     config argv). Auto-scan picks up `claude` on PATH as an External
///     channel; chat creation routes External + this field to terminal
///     launch mode; `agent_pty.rs` reads the argv contract from here.
///   - npm packages whose published bin name differs from the package
///     basename heuristic — synthesizes a binary distribution entry so
///     `auto_scan_path_binaries` finds the real bin on PATH and
///     `external_args_for` matches it to the right args.
///
/// Adding a future agent here = one entry, zero code changes elsewhere.
fn inject_grove_supplements(doc: &mut RegistryDocument) {
    if let Some(claude) = doc.agents.iter_mut().find(|a| a.id == "claude-acp") {
        claude.terminal_launch = Some(TerminalLaunch {
            cmd: "claude".to_string(),
            session_id_arg: "--session-id".to_string(),
            resume_arg: "--resume".to_string(),
            mcp_config_arg: "--mcp-config".to_string(),
        });
    }

    // External bin-name overrides for npm packages whose published bin
    // name doesn't match the package basename (the heuristic in
    // `installed_agents::probe_registry_agent`):
    //   - `@google/gemini-cli` ships bin `gemini`     (basename = `gemini-cli`)
    //   - `@github/copilot`    ships bin `copilot`   (id     = `github-copilot-cli`)
    //   - `droid`              ships bin `droid`     (id     = `factory-droid`)
    //
    // For each, we synthesize a binary distribution entry (archive empty
    // so the Marketplace install handler still rejects "binary install" —
    // the archive guard makes that a uniform data check, not a code
    // check), with cmd = the real bin name and args mirrored from the
    // npx distribution. Auto-scan probes `binary.<platform>.cmd` first,
    // so it picks up the right binary on PATH; `external_args_for`
    // matches the bin name to `binary.cmd` and pulls `binary.args` —
    // identical effect to running `npx <pkg> <args>` but with the
    // already-installed global binary.
    let bin_overrides: &[(&str, &str)] = &[
        ("gemini", "gemini"),
        ("github-copilot-cli", "copilot"),
        ("factory-droid", "droid"),
    ];
    let platform = crate::storage::agent_install::current_platform_key().to_string();
    for (agent_id, bin_name) in bin_overrides {
        let Some(agent) = doc.agents.iter_mut().find(|a| &a.id == agent_id) else {
            continue;
        };
        // Don't shadow an upstream-declared binary distribution.
        if agent.distribution.binary.contains_key(&platform) {
            continue;
        }
        let args = agent
            .distribution
            .npx
            .as_ref()
            .map(|n| n.args.clone())
            .unwrap_or_default();
        agent.distribution.binary.insert(
            platform.clone(),
            BinaryTarget {
                archive: String::new(),
                cmd: bin_name.to_string(),
                args,
                env: std::collections::HashMap::new(),
            },
        );
    }
}

/// Always-on synthetic entries for Trae and TraeX. No PATH probing here
/// — the entries appear in the catalog unconditionally; install state
/// is layered in by the marketplace handler via `installed_agents`.
///
/// Each entry uses `binary.<platform>` with an empty `archive` (so the
/// install handler short-circuits — they aren't downloadable) and the
/// canonical `acp serve` argv that the Trae CLIs document.
fn inject_trae_and_traex_entries(doc: &mut RegistryDocument) {
    let platform = crate::storage::agent_install::current_platform_key();

    // ByteDance internal — `<bin> acp serve` argv contract.
    // Description intentionally empty — these are internal CLIs, the
    // public Marketplace doesn't need a tagline.
    inject_one_synthetic(
        doc,
        SyntheticAgent {
            id: crate::storage::installed_agents::TRAE_ID,
            name: "Trae",
            binary_cmd: "traecli",
            binary_args: &["acp", "serve"],
            description: "",
            repository: Some("https://www.trae.ai/"),
            authors: &["ByteDance"],
        },
        platform,
    );
    inject_one_synthetic(
        doc,
        SyntheticAgent {
            id: crate::storage::installed_agents::TRAEX_ID,
            name: "TraeX",
            binary_cmd: "traex",
            binary_args: &["acp", "serve"],
            description: "",
            repository: Some("https://www.trae.ai/"),
            authors: &["ByteDance"],
        },
        platform,
    );

    // PATH-only ACP agents that don't ship through the public ACP
    // registry — same shape as Trae but `<bin> acp` (no `serve`).
    inject_one_synthetic(
        doc,
        SyntheticAgent {
            id: "hermes",
            name: "Hermes",
            binary_cmd: "hermes",
            binary_args: &["acp"],
            description: "Hermes — Nous Research's open-source agentic CLI.",
            repository: Some("https://github.com/NousResearch/hermes-cli"),
            authors: &["Nous Research"],
        },
        platform,
    );
    inject_one_synthetic(
        doc,
        SyntheticAgent {
            id: "kiro",
            name: "Kiro",
            binary_cmd: "kiro-cli",
            binary_args: &["acp"],
            description: "Kiro — AWS's agentic coding CLI.",
            repository: Some("https://kiro.dev/"),
            authors: &["Amazon Web Services"],
        },
        platform,
    );
    inject_one_synthetic(
        doc,
        SyntheticAgent {
            id: "openclaw",
            name: "OpenClaw",
            binary_cmd: "openclaw",
            binary_args: &["acp"],
            description: "OpenClaw — open-source ACP coding agent.",
            repository: None,
            authors: &[],
        },
        platform,
    );
}

/// Description of one synthetic agent's data. All fields static so the
/// table above is dense and grep-able.
struct SyntheticAgent {
    id: &'static str,
    name: &'static str,
    binary_cmd: &'static str,
    binary_args: &'static [&'static str],
    description: &'static str,
    repository: Option<&'static str>,
    authors: &'static [&'static str],
}

fn inject_one_synthetic(doc: &mut RegistryDocument, a: SyntheticAgent, platform: &str) {
    // If the upstream registry ever ships an entry with one of these
    // ids, prefer the synthetic (which carries our hardcoded launch
    // contract). This is defensive — these ids aren't expected in the
    // public registry but guard against future collisions.
    if doc.agents.iter().any(|x| x.id == a.id) {
        return;
    }
    let mut binary = std::collections::HashMap::new();
    binary.insert(
        platform.to_string(),
        BinaryTarget {
            // Empty archive → not downloadable. The install handler
            // rejects install attempts with a clear "not installable"
            // error so a user can't accidentally poison the table.
            archive: String::new(),
            cmd: a.binary_cmd.to_string(),
            args: a.binary_args.iter().map(|s| s.to_string()).collect(),
            env: std::collections::HashMap::new(),
        },
    );
    doc.agents.push(RegistryAgent {
        id: a.id.to_string(),
        name: a.name.to_string(),
        // Version is intentionally blank — synthetic entries don't track
        // catalog-wide versions; the actual installed version comes from
        // `installed_agents.installations[*].version` if present.
        version: String::new(),
        description: a.description.to_string(),
        repository: a.repository.map(|s| s.to_string()),
        website: None,
        authors: a.authors.iter().map(|s| s.to_string()).collect(),
        license: None,
        icon: None,
        distribution: Distribution {
            npx: None,
            uvx: None,
            binary,
            local: None,
        },
        terminal_launch: None,
    });
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

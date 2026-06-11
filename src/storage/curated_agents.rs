//! Curated agent list — the "ship by default" subset of the ACP registry.
//!
//! On first launch grove copies an embedded `curated_agents.json` into
//! `~/.grove/builtin-agents/curated.json`. The marketplace modal uses this
//! list to render the default landing view (4 cards) and to power the
//! "Install recommended agents" onboarding card new users see when the
//! marketplace opens for the first time with no installed agents.
//!
//! Why ship a curated list at all? The full registry has 37 agents — showing
//! all of them to a new user is overwhelming, and most users only need 2-3.
//! The curated list is the "default sensible choices" answer; users can
//! switch to the full registry view from the marketplace toolbar.
//!
//! Why a file on disk instead of a `const`? The list is small (4 ids) but
//! having it as a real file means:
//!   - Operators can add/remove entries without recompiling grove
//!   - Tests can swap the file at runtime to verify the onboarding flow
//!   - The marketplace modal can link to a human-readable "why these 4?"
//!     explanation served as a static asset in a future iteration
//!
//! The on-disk file is **not** a list of pre-installed agents — it lists
//! the agents grove recommends installing. The user still has to opt in
//! (one click "Install all" or per-card install).

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

use crate::error::Result;

const CURATED_JSON: &str = include_str!("curated_agents.json");

/// On-disk shape of the curated list. `version` lets us rev the schema
/// without invalidating the boot copy logic; `agents` is the ordered list
/// of canonical agent ids grove recommends to new users.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CuratedList {
    pub version: u32,
    pub agents: Vec<String>,
}

impl CuratedList {
    /// Parse the embedded default. Panics on parse failure — a malformed
    /// curated.json is a build bug, not a runtime condition; better to fail
    /// at the call site than return an empty list that would silently break
    /// the onboarding flow.
    pub fn embedded() -> Self {
        serde_json::from_str(CURATED_JSON)
            .expect("curated_agents.json is malformed — this is a build bug")
    }
}

fn curated_dir() -> PathBuf {
    super::grove_dir().join("builtin-agents")
}

fn curated_path() -> PathBuf {
    curated_dir().join("curated.json")
}

/// Idempotent first-launch bootstrap.
///
/// On every server start, ensure `~/.grove/builtin-agents/curated.json`
/// exists. If it does not (first launch, or a user who wiped the dir), copy
/// the embedded default. If it already exists, leave it alone — the user
/// (or a future grove version) may have customized it.
///
/// Returns the path of the on-disk file so the caller can log it on
/// first-touch (so the user knows where to look if they want to tune it).
pub fn ensure_curated_file() -> Result<PathBuf> {
    let path = curated_path();
    if !path.exists() {
        let dir = curated_dir();
        std::fs::create_dir_all(&dir)?;
        std::fs::write(&path, CURATED_JSON)?;
        // P3.11: log the first-touch so the boot output makes the
        // file's location discoverable. The marketplace modal links
        // to this same path in its "about curated" help text.
        eprintln!(
            "[curated_agents] first-touch bootstrap — wrote embedded default to {}",
            path.display()
        );
    }
    Ok(path)
}

/// Read the curated list from disk. Returns the embedded default if the
/// file is missing or malformed (the on-disk file is an operator override
/// — if the override is broken we fall back to the embedded list rather
/// than crashing the marketplace modal).
pub fn load() -> CuratedList {
    match std::fs::read(curated_path()) {
        Ok(bytes) => serde_json::from_slice::<CuratedList>(&bytes).unwrap_or_else(|e| {
            eprintln!(
                "[curated_agents] on-disk curated.json is malformed ({}), falling back to embedded default",
                e
            );
            CuratedList::embedded()
        }),
        Err(_) => CuratedList::embedded(),
    }
}

/// Pure-function helper: filter a slice of agents down to the curated ids
/// in curated order. Agents missing from the registry (offline / cache not
/// yet populated) are silently dropped — the marketplace modal surfaces
/// "agent not currently available" via the registry_stale flag.
///
/// Exposed for tests + future callers (CLI tooling, headless installers)
/// that want the curated-first ordering on a custom agent slice. The
/// HTTP `/agents/marketplace` endpoint returns the full list + the
/// curated id list so the frontend can render both views without a
/// second round-trip.
#[allow(dead_code)]
pub fn filter_curated<'a, T>(
    agents: &'a [T],
    curated: &[String],
    id_of: impl Fn(&T) -> &str,
) -> Vec<&'a T> {
    let mut out = Vec::with_capacity(curated.len());
    for cid in curated {
        if let Some(a) = agents.iter().find(|a| id_of(a) == cid) {
            out.push(a);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn embedded_parses() {
        let list = CuratedList::embedded();
        assert!(list.version >= 1);
        assert!(!list.agents.is_empty());
        // Sanity: the 5 npx-installable curated ids. (opencode was dropped
        // because its registry distribution is binary-only; auto_scan
        // picks it up from PATH if installed.)
        for expected in [
            "claude-acp",
            "codex-acp",
            "gemini",
            "github-copilot-cli",
            "qwen-code",
        ] {
            assert!(
                list.agents.contains(&expected.to_string()),
                "curated list missing {}",
                expected
            );
        }
    }

    #[test]
    fn filter_curated_preserves_order() {
        let agents: Vec<(String, &str)> = vec![
            ("opencode".into(), "OpenCode"),
            ("claude-acp".into(), "Claude"),
            ("gemini".into(), "Gemini"),
        ];
        let curated = vec!["claude-acp".into(), "gemini".into(), "opencode".into()];
        let filtered = filter_curated(&agents, &curated, |a| &a.0);
        let names: Vec<&str> = filtered.iter().map(|a| a.1).collect();
        assert_eq!(names, vec!["Claude", "Gemini", "OpenCode"]);
    }

    #[test]
    fn filter_curated_drops_unknown() {
        let agents: Vec<(String, &str)> = vec![("claude-acp".into(), "Claude")];
        let curated = vec!["claude-acp".into(), "future-agent".into()];
        let filtered = filter_curated(&agents, &curated, |a| &a.0);
        assert_eq!(filtered.len(), 1);
    }
}

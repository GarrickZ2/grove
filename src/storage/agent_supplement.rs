//! Builtin agent supplement.
//!
//! ACP registry (https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json)
//! covers most agents we ship, but:
//!
//!   1. A few agents (hermes, kiro, openclaw, traecli) aren't in the registry
//!      yet — we still need them in the picker, with no `distribution`.
//!   2. The registry doesn't track grove-specific data: which legacy id this
//!      agent used (claude → claude-acp alias), what command to probe for
//!      "auto-detected" state, whether the base CLI supports terminal mode,
//!      and the terminal-mode spawn template.
//!
//! This module is the single source of all that grove-internal data. Merging
//! supplement + registry produces the unified `MarketplaceAgent` view that the
//! frontend consumes.
//!
//! Adding a new entry here is the only step needed for a new builtin agent
//! (assuming its registry entry already exists). New terminal-capable agents
//! get a `terminal_profile`; everyone else is ACP-only by default.

use std::borrow::Cow;

/// One supplement entry — matched against the registry by `canonical_id`
/// or fallback to standalone display when registry has no match.
#[derive(Debug, Clone)]
pub struct SupplementEntry {
    /// Registry id we expect to match (`claude-acp`). For entries not in the
    /// registry yet (`hermes`, `kiro`, ...), this is the grove-internal id and
    /// the marketplace view will mark them `distribution = None`.
    pub canonical_id: &'static str,
    /// Legacy ids that historic ChatSession.agent rows / config.acp.agent_command
    /// values may carry. Looked up by `resolve_agent_id`.
    pub legacy_aliases: &'static [&'static str],
    /// Grove-side icon identifier — the frontend maps this to an actual asset.
    /// Distinct from `registry.icon` (the CDN-hosted svg URL) because we want
    /// to keep our crisp local SVGs as the primary icon source.
    pub icon_id: &'static str,
    /// Display label override. `None` falls back to `registry.name`.
    pub display_name: Option<&'static str>,
    /// PATH command to probe for "agent CLI is locally installed". Used by
    /// auto-detect — if found, marketplace sets installState=auto-detected
    /// even when grove never ran the installer.
    pub terminal_check: Option<&'static str>,
    /// PATH command to probe for "ACP wrapper is locally available".
    pub acp_check: Option<&'static str>,
    /// Deprecated ACP wrapper name (e.g. claude-code-acp before claude-agent-acp).
    /// Tried as a fallback so users running an old install still light up green.
    pub acp_fallback: Option<&'static str>,
    /// npm package to pass to `npx` when probing/launching via npx fallback.
    pub npx_package: Option<&'static str>,
    /// Launch modes the agent supports. `["acp"]` is the default; "terminal"
    /// is only added when we've verified the base CLI honors externally-set
    /// session IDs (see `terminal_profile`).
    pub supported_launch_modes: &'static [&'static str],
    /// Spawn template for terminal mode. Present iff `supported_launch_modes`
    /// contains "terminal".
    pub terminal_profile: Option<TerminalProfile>,
}

/// How to spawn an agent's base CLI under a PTY for terminal-mode chats.
/// Templates support `{uuid}` (the per-chat session UUID grove tracks),
/// `{cwd}` (worktree path), `{cwd_slug}` (cwd with `/` replaced by `-`).
#[derive(Debug, Clone)]
pub struct TerminalProfile {
    pub base_command: &'static str,
    pub fresh_args: &'static [&'static str],
    pub resume_args: &'static [&'static str],
    /// Path template to check existence — present file means session is
    /// already on disk and we should use `resume_args`. Missing means use
    /// `fresh_args` (creates the session).
    pub resume_check_pattern: &'static str,
}

/// All builtin supplement entries. Order: claude first (most-used + only
/// terminal-capable today), then alphabetical-ish.
pub const BUILTIN_SUPPLEMENTS: &[SupplementEntry] = &[
    SupplementEntry {
        canonical_id: "claude-acp",
        legacy_aliases: &["claude"],
        icon_id: "claude",
        display_name: Some("Claude Code"),
        terminal_check: Some("claude"),
        acp_check: Some("claude-agent-acp"),
        acp_fallback: Some("claude-code-acp"),
        npx_package: Some("@agentclientprotocol/claude-agent-acp"),
        supported_launch_modes: &["acp", "terminal"],
        terminal_profile: Some(TerminalProfile {
            base_command: "claude",
            fresh_args: &["--session-id", "{uuid}"],
            resume_args: &["--resume", "{uuid}"],
            resume_check_pattern: "~/.claude/projects/{cwd_slug}/{uuid}.jsonl",
        }),
    },
    SupplementEntry {
        canonical_id: "codex-acp",
        legacy_aliases: &["codex"],
        icon_id: "codex",
        display_name: Some("CodeX"),
        terminal_check: Some("codex"),
        acp_check: Some("codex-acp"),
        acp_fallback: None,
        npx_package: Some("@zed-industries/codex-acp"),
        supported_launch_modes: &["acp"],
        terminal_profile: None,
    },
    SupplementEntry {
        canonical_id: "cursor",
        legacy_aliases: &["cursor-agent"],
        icon_id: "cursor",
        display_name: Some("Cursor"),
        terminal_check: Some("cursor-agent"),
        acp_check: Some("cursor-agent"),
        acp_fallback: None,
        npx_package: None,
        supported_launch_modes: &["acp"],
        terminal_profile: None,
    },
    SupplementEntry {
        canonical_id: "gemini",
        legacy_aliases: &[],
        icon_id: "gemini",
        display_name: Some("Gemini"),
        terminal_check: Some("gemini"),
        acp_check: Some("gemini"),
        acp_fallback: None,
        npx_package: None,
        supported_launch_modes: &["acp"],
        terminal_profile: None,
    },
    SupplementEntry {
        canonical_id: "github-copilot-cli",
        legacy_aliases: &["gh-copilot"],
        icon_id: "gh-copilot",
        display_name: Some("GitHub Copilot"),
        terminal_check: Some("copilot"),
        acp_check: Some("copilot"),
        acp_fallback: None,
        npx_package: None,
        supported_launch_modes: &["acp"],
        terminal_profile: None,
    },
    SupplementEntry {
        canonical_id: "junie",
        legacy_aliases: &[],
        icon_id: "junie",
        display_name: Some("Junie"),
        terminal_check: Some("junie"),
        acp_check: Some("junie"),
        acp_fallback: None,
        npx_package: None,
        supported_launch_modes: &["acp"],
        terminal_profile: None,
    },
    SupplementEntry {
        canonical_id: "kimi",
        legacy_aliases: &[],
        icon_id: "kimi",
        display_name: Some("Kimi"),
        terminal_check: Some("kimi"),
        acp_check: Some("kimi"),
        acp_fallback: None,
        npx_package: None,
        supported_launch_modes: &["acp"],
        terminal_profile: None,
    },
    SupplementEntry {
        canonical_id: "opencode",
        legacy_aliases: &[],
        icon_id: "opencode",
        display_name: Some("OpenCode"),
        terminal_check: Some("opencode"),
        acp_check: Some("opencode"),
        acp_fallback: None,
        npx_package: None,
        supported_launch_modes: &["acp"],
        terminal_profile: None,
    },
    SupplementEntry {
        canonical_id: "qwen-code",
        legacy_aliases: &["qwen"],
        icon_id: "qwen",
        display_name: Some("Qwen"),
        terminal_check: Some("qwen"),
        acp_check: Some("qwen"),
        acp_fallback: None,
        npx_package: None,
        supported_launch_modes: &["acp"],
        terminal_profile: None,
    },
    // Below: not in registry today. distribution will be None in the
    // marketplace view. Auto-detect via probe still works.
    SupplementEntry {
        canonical_id: "hermes",
        legacy_aliases: &[],
        icon_id: "hermes",
        display_name: Some("Hermes"),
        terminal_check: Some("hermes"),
        acp_check: Some("hermes acp"),
        acp_fallback: None,
        npx_package: None,
        supported_launch_modes: &["acp"],
        terminal_profile: None,
    },
    SupplementEntry {
        canonical_id: "kiro",
        legacy_aliases: &[],
        icon_id: "kiro",
        display_name: Some("Kiro"),
        terminal_check: Some("kiro-cli"),
        acp_check: Some("kiro-cli acp"),
        acp_fallback: None,
        npx_package: None,
        supported_launch_modes: &["acp"],
        terminal_profile: None,
    },
    SupplementEntry {
        canonical_id: "openclaw",
        legacy_aliases: &[],
        icon_id: "openclaw",
        display_name: Some("OpenClaw"),
        terminal_check: Some("openclaw"),
        acp_check: Some("openclaw acp"),
        acp_fallback: None,
        npx_package: None,
        supported_launch_modes: &["acp"],
        terminal_profile: None,
    },
    SupplementEntry {
        canonical_id: "traecli",
        legacy_aliases: &[],
        icon_id: "traecli",
        display_name: Some("Trae"),
        terminal_check: Some("traecli"),
        acp_check: Some("traecli"),
        acp_fallback: None,
        npx_package: None,
        supported_launch_modes: &["acp"],
        terminal_profile: None,
    },
];

/// Look up a supplement entry by canonical id or any legacy alias.
pub fn find_supplement(id: &str) -> Option<&'static SupplementEntry> {
    BUILTIN_SUPPLEMENTS
        .iter()
        .find(|entry| entry.canonical_id == id || entry.legacy_aliases.contains(&id))
}

/// Resolve any legacy or canonical id to the canonical id. Unknown ids pass
/// through unchanged (covers post-supplement registry-only agents).
pub fn resolve_agent_id(id: &str) -> Cow<'_, str> {
    if let Some(entry) = find_supplement(id) {
        Cow::Borrowed(entry.canonical_id)
    } else {
        Cow::Borrowed(id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legacy_claude_resolves_to_canonical() {
        assert_eq!(&*resolve_agent_id("claude"), "claude-acp");
        assert_eq!(&*resolve_agent_id("claude-acp"), "claude-acp");
    }

    #[test]
    fn unknown_id_passes_through() {
        assert_eq!(&*resolve_agent_id("future-agent"), "future-agent");
    }

    #[test]
    fn only_claude_has_terminal_profile() {
        let with_terminal: Vec<_> = BUILTIN_SUPPLEMENTS
            .iter()
            .filter(|e| e.terminal_profile.is_some())
            .map(|e| e.canonical_id)
            .collect();
        assert_eq!(with_terminal, vec!["claude-acp"]);
    }

    #[test]
    fn supplement_ids_unique() {
        let mut ids: Vec<&str> = BUILTIN_SUPPLEMENTS.iter().map(|e| e.canonical_id).collect();
        ids.sort();
        let len_before = ids.len();
        ids.dedup();
        assert_eq!(
            len_before,
            ids.len(),
            "duplicate canonical_id in BUILTIN_SUPPLEMENTS"
        );
    }
}

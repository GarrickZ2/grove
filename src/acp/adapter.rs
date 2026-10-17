//! Per-agent content adapter for ACP tool call content conversion.
//!
//! Different agents embed different metadata in tool call content (e.g. Claude Code
//! injects `<system-reminder>` tags). This module provides a trait to handle these
//! agent-specific differences while keeping the rest of the content pipeline generic.

use std::path::Path;

// Keep ACP v1 schema types behind a local namespace so adapter call sites stay concise.
mod acp {
    pub use agent_client_protocol::schema::v1::*;
}

use super::adapter_terminal::parse_terminal_meta;
pub use super::adapter_terminal::AgentTerminalEvent;
use super::content_block_to_text;

/// Trait for agent-specific tool call content conversion.
pub trait AgentContentAdapter: Send + Sync {
    /// Convert `ToolCallContent` to display text.
    ///
    /// Implementations may apply agent-specific cleanup (e.g. stripping tags).
    fn tool_call_content_to_text(&self, tc: &acp::ToolCallContent) -> String;

    /// Apply agent-specific negotiation without changing the client identity.
    fn configure_client_capabilities(&self, _capabilities: &mut acp::ClientCapabilities) {}

    fn supports_subagents_legacy(&self) -> bool {
        false
    }

    fn supports_terminal_metadata(&self) -> bool {
        false
    }

    /// Decode only metadata conventions understood by this agent adapter.
    fn terminal_events(&self, _meta: Option<&acp::Meta>) -> Vec<AgentTerminalEvent> {
        Vec::new()
    }
}

/// Default adapter — direct conversion without any agent-specific processing.
pub struct DefaultAdapter;

impl AgentContentAdapter for DefaultAdapter {
    fn tool_call_content_to_text(&self, tc: &acp::ToolCallContent) -> String {
        match tc {
            acp::ToolCallContent::Content(content) => content_block_to_text(&content.content),
            acp::ToolCallContent::Diff(diff) => format_diff(diff),
            acp::ToolCallContent::Terminal(term) => format!("[Terminal: {}]", term.terminal_id.0),
            _ => "<unknown>".to_string(),
        }
    }
}

/// Claude Code adapter — strips `<system-reminder>` tags from content.
pub struct ClaudeAdapter;

impl AgentContentAdapter for ClaudeAdapter {
    fn supports_subagents_legacy(&self) -> bool {
        true
    }
    fn supports_terminal_metadata(&self) -> bool {
        true
    }

    fn terminal_events(&self, meta: Option<&acp::Meta>) -> Vec<AgentTerminalEvent> {
        parse_terminal_meta(meta)
    }

    fn tool_call_content_to_text(&self, tc: &acp::ToolCallContent) -> String {
        let raw = DefaultAdapter.tool_call_content_to_text(tc);
        strip_system_reminders(&raw)
    }
}

/// Codex keeps command execution agent-side and streams Zed terminal metadata.
pub struct CodexAdapter;

impl AgentContentAdapter for CodexAdapter {
    fn configure_client_capabilities(&self, capabilities: &mut acp::ClientCapabilities) {
        // codex-acp 2.2.2's bundled SDK strips the unstable top-level
        // `subagents` field before its own capability check. Its documented
        // extension is the surviving negotiation path. Advertise only native
        // child sessions, not unrelated AIR features. Claude must retain the
        // standard path because this namespace selects its older draft.
        let meta = capabilities.meta.get_or_insert_with(Default::default);
        meta.insert(
            "jetbrains".into(),
            serde_json::json!({
                "air": { "version": 1, "capabilities": ["nativeSubagentSessions"] }
            }),
        );
        // This extension also selects Codex's alternate tool renderer. Keep
        // its output chunk channel explicit so command output cannot disappear.
        meta.insert("terminal_output_delta".into(), true.into());
    }

    fn supports_subagents_legacy(&self) -> bool {
        true
    }
    fn supports_terminal_metadata(&self) -> bool {
        true
    }

    fn tool_call_content_to_text(&self, tc: &acp::ToolCallContent) -> String {
        DefaultAdapter.tool_call_content_to_text(tc)
    }

    fn terminal_events(&self, meta: Option<&acp::Meta>) -> Vec<AgentTerminalEvent> {
        parse_terminal_meta(meta)
    }
}

/// Convert ACP Diff to display string.
fn format_diff(diff: &acp::Diff) -> String {
    let path_str = diff.path.display().to_string();
    format_diff_content(&path_str, diff.old_text.as_deref(), &diff.new_text)
}

/// Generate diff from file snapshots (fallback when ACP provides no content).
///
/// Used for Write/Edit tool calls where the agent doesn't send content in ToolCallUpdate.
pub fn generate_file_diff(path: &Path, old: Option<&str>, new: &str) -> String {
    let path_str = path.display().to_string();
    format_diff_content(&path_str, old, new)
}

/// Format one ACP Diff as a self-contained git-style patch.
///
/// The file headers are intentionally retained even though the UI already has
/// a file chip: a single ACP tool call may contain several Diff blocks, and
/// downstream clients need an unambiguous boundary to associate each patch and
/// its line counts with the correct file.
fn format_diff_content(path: &str, old: Option<&str>, new: &str) -> String {
    let git_path = path.trim_start_matches('/');
    let old_text = old.unwrap_or_default();
    let old_header = if old.is_none() {
        "/dev/null".to_string()
    } else {
        format!("a/{git_path}")
    };
    let body = build_unified_diff(path, old_text, new);
    format!("diff --git a/{git_path} b/{git_path}\n--- {old_header}\n+++ b/{git_path}\n{body}")
}

/// Build unified diff using `similar` crate with context lines.
/// Omits `---`/`+++` file header (title already shows the file path).
fn build_unified_diff(_path: &str, old: &str, new: &str) -> String {
    use similar::{ChangeTag, TextDiff};

    let diff = TextDiff::from_lines(old, new);
    let mut out = String::new();

    for hunk in diff.unified_diff().context_radius(3).iter_hunks() {
        // Hunk header
        out.push_str(&format!("{}\n", hunk.header()));

        for change in hunk.iter_changes() {
            let sign = match change.tag() {
                ChangeTag::Delete => '-',
                ChangeTag::Insert => '+',
                ChangeTag::Equal => ' ',
            };
            out.push(sign);
            out.push_str(change.value());
            // Ensure each line ends with newline
            if !change.value().ends_with('\n') {
                out.push('\n');
            }
        }
    }

    if out.is_empty() {
        out.push_str("(no changes)\n");
    }

    out
}

/// Remove all `<system-reminder>...</system-reminder>` blocks from text.
fn strip_system_reminders(text: &str) -> String {
    let mut result = text.to_string();
    while let Some(start) = result.find("<system-reminder>") {
        if let Some(end) = result[start..].find("</system-reminder>") {
            let end_abs = start + end + "</system-reminder>".len();
            result = format!("{}{}", &result[..start], &result[end_abs..]);
        } else {
            break;
        }
    }
    result.trim().to_string()
}

/// Resolve the appropriate adapter based on the agent name, falling back to
/// command-string matching for custom agents whose id isn't a known builtin.
pub fn resolve_adapter(agent_name: &str, agent_command: &str) -> Box<dyn AgentContentAdapter> {
    if matches!(
        agent_name,
        "claude"
            | "claude-acp"
            | "claude-agent-acp"
            | "claude-code-acp"
            | "@agentclientprotocol/claude-agent-acp"
    ) {
        return Box::new(ClaudeAdapter);
    }
    let cmd_tail = agent_command.rsplit('/').next().unwrap_or(agent_command);
    if cmd_tail.contains("claude-code-acp") || cmd_tail.contains("claude-agent-acp") {
        return Box::new(ClaudeAdapter);
    }
    if matches!(
        agent_name,
        "codex" | "codex-acp" | "@agentclientprotocol/codex-acp" | "@zed-industries/codex-acp"
    ) || cmd_tail.contains("codex-acp")
    {
        return Box::new(CodexAdapter);
    }
    Box::new(DefaultAdapter)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codex_negotiation_survives_the_legacy_sdk_without_switching_claude_to_air() {
        let base = crate::acp::grove_client_capabilities();
        for (name, command, legacy) in [
            ("codex", "codex-acp", true),
            ("@agentclientprotocol/codex-acp", "npx", true),
            ("custom", "/bin/codex-acp", true),
            ("claude", "claude-agent-acp", false),
            ("other", "other", false),
        ] {
            let mut capabilities = base.clone();
            capabilities.meta = Some(acp::Meta::from_iter([(
                "terminal_output".into(),
                true.into(),
            )]));
            resolve_adapter(name, command).configure_client_capabilities(&mut capabilities);
            let wire = serde_json::to_value(capabilities).unwrap();
            assert!(wire["subagents"].is_object());
            assert_eq!(wire["_meta"]["terminal_output"], true);
            if legacy {
                assert_eq!(
                    wire["_meta"]["jetbrains"]["air"]["capabilities"],
                    serde_json::json!(["nativeSubagentSessions"])
                );
                assert_eq!(wire["_meta"]["terminal_output_delta"], true);
            } else {
                assert!(wire["_meta"].get("jetbrains").is_none());
            }
        }
    }

    #[test]
    fn test_strip_system_reminders_basic() {
        let input = "Hello <system-reminder>secret</system-reminder> World";
        assert_eq!(strip_system_reminders(input), "Hello  World");
    }

    #[test]
    fn test_strip_system_reminders_multiple() {
        let input = "<system-reminder>a</system-reminder>text<system-reminder>b</system-reminder>";
        assert_eq!(strip_system_reminders(input), "text");
    }

    #[test]
    fn test_strip_system_reminders_no_tags() {
        let input = "plain text";
        assert_eq!(strip_system_reminders(input), "plain text");
    }

    #[test]
    fn test_strip_system_reminders_unclosed() {
        let input = "before <system-reminder>unclosed";
        assert_eq!(
            strip_system_reminders(input),
            "before <system-reminder>unclosed"
        );
    }

    /// Helper: create a ToolCallContent::Content with the given text
    fn text_tc(s: &str) -> acp::ToolCallContent {
        let block: acp::ToolCallContent = acp::ContentBlock::Text(acp::TextContent::new(s)).into();
        block
    }

    #[test]
    fn test_resolve_adapter_claude() {
        let adapter = resolve_adapter("claude", "claude-agent-acp");
        let tc = text_tc("hello <system-reminder>secret</system-reminder> world");
        assert_eq!(adapter.tool_call_content_to_text(&tc), "hello  world");
    }

    #[test]
    fn test_resolve_adapter_default() {
        let adapter = resolve_adapter("codex", "codex-acp");
        let tc = text_tc("hello <system-reminder>visible</system-reminder> world");
        assert_eq!(
            adapter.tool_call_content_to_text(&tc),
            "hello <system-reminder>visible</system-reminder> world"
        );
    }

    #[test]
    fn test_resolve_adapter_with_other_agent() {
        let adapter = resolve_adapter("gemini", "gemini");
        let tc = text_tc("<system-reminder>gone</system-reminder>kept");
        assert_eq!(
            adapter.tool_call_content_to_text(&tc),
            "<system-reminder>gone</system-reminder>kept"
        );
    }

    #[test]
    fn test_resolve_adapter_custom_id_falls_back_to_command() {
        // Custom agent with non-builtin id but a claude-* command — should still
        // get ClaudeAdapter via command-string fallback.
        let adapter = resolve_adapter("my-claude", "/usr/local/bin/claude-agent-acp");
        let tc = text_tc("hello <system-reminder>secret</system-reminder> world");
        assert_eq!(adapter.tool_call_content_to_text(&tc), "hello  world");
    }

    #[test]
    fn test_format_diff_new_file() {
        let diff = acp::Diff::new("src/main.rs", "fn main() {\n    println!(\"hello\");\n}");
        let result = format_diff(&diff);
        assert!(result.starts_with(
            "diff --git a/src/main.rs b/src/main.rs\n--- /dev/null\n+++ b/src/main.rs\n"
        ));
        assert!(result.contains("+fn main() {"));
    }

    #[test]
    fn test_format_diff_edit() {
        let diff = acp::Diff::new("src/lib.rs", "line 1\nnew content\nline 3")
            .old_text("line 1\nold content\nline 3".to_string());
        let result = format_diff(&diff);
        assert!(result.starts_with(
            "diff --git a/src/lib.rs b/src/lib.rs\n--- a/src/lib.rs\n+++ b/src/lib.rs\n"
        ));
        assert!(result.contains("-old content"));
        assert!(result.contains("+new content"));
        assert!(result.contains(" line 1"));
    }

    #[test]
    fn test_format_diff_empty_old() {
        let diff = acp::Diff::new("new.txt", "hello").old_text(String::new());
        let result = format_diff(&diff);
        assert!(
            result.starts_with("diff --git a/new.txt b/new.txt\n--- a/new.txt\n+++ b/new.txt\n")
        );
        assert!(result.contains("+hello"));
    }

    #[test]
    fn test_generate_file_diff_new() {
        use std::path::PathBuf;
        let path = PathBuf::from("/tmp/test.py");
        let result = generate_file_diff(&path, None, "print('hello')");
        assert!(result.starts_with(
            "diff --git a/tmp/test.py b/tmp/test.py\n--- /dev/null\n+++ b/tmp/test.py\n"
        ));
        assert!(result.contains("+print('hello')"));
    }

    #[test]
    fn test_generate_file_diff_edit() {
        use std::path::PathBuf;
        let path = PathBuf::from("/tmp/requirements.txt");
        let old = "fastapi==0.109.2\nuvicorn==0.27.1";
        let new = "fastapi==0.109.2\nuvicorn==0.27.1\npsutil==5.9.8";
        let result = generate_file_diff(&path, Some(old), new);
        assert!(result.contains("+psutil==5.9.8"));
        assert!(result.contains(" fastapi==0.109.2"));
    }
}

//! Per-agent content adapter for ACP tool call content conversion.
//!
//! Different agents embed different metadata in tool call content (e.g. Claude Code
//! injects `<system-reminder>` tags). This module provides a trait to handle these
//! agent-specific differences while keeping the rest of the content pipeline generic.

use agent_client_protocol as acp;

use super::content_block_to_text;

/// Trait for agent-specific tool call content conversion.
pub trait AgentContentAdapter: Send + Sync {
    /// Convert `ToolCallContent` to display text.
    ///
    /// Implementations may apply agent-specific cleanup (e.g. stripping tags).
    fn tool_call_content_to_text(&self, tc: &acp::ToolCallContent) -> String;
}

/// Default adapter — direct conversion without any agent-specific processing.
pub struct DefaultAdapter;

impl AgentContentAdapter for DefaultAdapter {
    fn tool_call_content_to_text(&self, tc: &acp::ToolCallContent) -> String {
        match tc {
            acp::ToolCallContent::Content(content) => content_block_to_text(&content.content),
            acp::ToolCallContent::Diff(diff) => format!("diff: {}", diff.path.display()),
            acp::ToolCallContent::Terminal(term) => format!("[Terminal: {}]", term.terminal_id.0),
            _ => "<unknown>".to_string(),
        }
    }
}

/// Claude Code adapter — strips `<system-reminder>` tags from content.
pub struct ClaudeAdapter;

impl AgentContentAdapter for ClaudeAdapter {
    fn tool_call_content_to_text(&self, tc: &acp::ToolCallContent) -> String {
        let raw = DefaultAdapter.tool_call_content_to_text(tc);
        strip_system_reminders(&raw)
    }
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

/// Resolve the appropriate adapter based on the agent command.
pub fn resolve_adapter(agent_command: &str) -> Box<dyn AgentContentAdapter> {
    let cmd = agent_command.rsplit('/').next().unwrap_or(agent_command);
    match cmd {
        "claude-code-acp" => Box::new(ClaudeAdapter),
        _ => Box::new(DefaultAdapter),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
        let adapter = resolve_adapter("claude-code-acp");
        let tc = text_tc("hello <system-reminder>secret</system-reminder> world");
        assert_eq!(adapter.tool_call_content_to_text(&tc), "hello  world");
    }

    #[test]
    fn test_resolve_adapter_default() {
        let adapter = resolve_adapter("some-other-agent");
        let tc = text_tc("hello <system-reminder>visible</system-reminder> world");
        assert_eq!(
            adapter.tool_call_content_to_text(&tc),
            "hello <system-reminder>visible</system-reminder> world"
        );
    }

    #[test]
    fn test_resolve_adapter_with_path() {
        let adapter = resolve_adapter("/usr/local/bin/claude-code-acp");
        let tc = text_tc("<system-reminder>gone</system-reminder>kept");
        assert_eq!(adapter.tool_call_content_to_text(&tc), "kept");
    }
}

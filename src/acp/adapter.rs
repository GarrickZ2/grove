//! Per-agent content adapter for ACP tool call content conversion.
//!
//! Different agents embed different metadata in tool call content (e.g. Claude Code
//! injects `<system-reminder>` tags). This module provides a trait to handle these
//! agent-specific differences while keeping the rest of the content pipeline generic.

use std::path::Path;

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
            acp::ToolCallContent::Diff(diff) => format_diff(diff),
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

/// Convert ACP Diff to display string.
fn format_diff(diff: &acp::Diff) -> String {
    let path_str = diff
        .path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| diff.path.display().to_string());
    format_diff_content(&path_str, diff.old_text.as_deref(), &diff.new_text)
}

/// Generate diff from file snapshots (fallback when ACP provides no content).
///
/// Used for Write/Edit tool calls where the agent doesn't send content in ToolCallUpdate.
pub fn generate_file_diff(path: &Path, old: Option<&str>, new: &str) -> String {
    // Use file name only (title already shows the full path)
    let path_str = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.display().to_string());
    format_diff_content(&path_str, old, new)
}

/// Core diff formatting: new file → markdown code block, edit → real unified diff.
fn format_diff_content(path: &str, old: Option<&str>, new: &str) -> String {
    match old {
        None | Some("") => {
            // New file: markdown code fence with language from extension
            let lang = path.rsplit('.').next().map(ext_to_lang).unwrap_or("");
            format!("```{lang}\n{new}\n```")
        }
        Some(old_text) => {
            // Edit: real unified diff with 3 lines of context
            build_unified_diff(path, old_text, new)
        }
    }
}

/// Map file extension to markdown language identifier.
fn ext_to_lang(ext: &str) -> &str {
    // Case-insensitive matching via known lowercase variants
    match ext {
        "rs" => "rust",
        "ts" | "tsx" => "typescript",
        "js" | "jsx" | "mjs" | "cjs" => "javascript",
        "py" => "python",
        "rb" => "ruby",
        "go" => "go",
        "java" => "java",
        "kt" | "kts" => "kotlin",
        "swift" => "swift",
        "c" | "h" => "c",
        "cpp" | "cc" | "cxx" | "hpp" => "cpp",
        "cs" => "csharp",
        "sh" | "bash" | "zsh" => "bash",
        "json" => "json",
        "yaml" | "yml" => "yaml",
        "toml" => "toml",
        "xml" => "xml",
        "html" | "htm" => "html",
        "css" | "scss" | "less" => "css",
        "sql" => "sql",
        "md" | "markdown" => "markdown",
        "dockerfile" => "dockerfile",
        "txt" | "text" | "log" | "" => "",
        _ => ext,
    }
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

    #[test]
    fn test_format_diff_new_file() {
        let diff = acp::Diff::new("src/main.rs", "fn main() {\n    println!(\"hello\");\n}");
        let result = format_diff(&diff);
        // New file → markdown code block with language
        assert!(result.starts_with("```rust\n"));
        assert!(result.contains("fn main() {"));
        assert!(result.ends_with("\n```"));
    }

    #[test]
    fn test_format_diff_edit() {
        let diff = acp::Diff::new("src/lib.rs", "line 1\nnew content\nline 3")
            .old_text("line 1\nold content\nline 3".to_string());
        let result = format_diff(&diff);
        // Edit → unified diff without file header (starts with @@ hunk)
        assert!(result.starts_with("@@"));
        assert!(!result.contains("---"));
        assert!(result.contains("-old content"));
        assert!(result.contains("+new content"));
        assert!(result.contains(" line 1"));
    }

    #[test]
    fn test_format_diff_empty_old() {
        let diff = acp::Diff::new("new.txt", "hello").old_text(String::new());
        let result = format_diff(&diff);
        // Empty old → treated as new file
        assert!(result.starts_with("```\n"));
        assert!(result.contains("hello"));
    }

    #[test]
    fn test_ext_to_lang() {
        assert_eq!(ext_to_lang("rs"), "rust");
        assert_eq!(ext_to_lang("tsx"), "typescript");
        assert_eq!(ext_to_lang("py"), "python");
        assert_eq!(ext_to_lang("txt"), "");
    }

    #[test]
    fn test_generate_file_diff_new() {
        use std::path::PathBuf;
        let path = PathBuf::from("/tmp/test.py");
        let result = generate_file_diff(&path, None, "print('hello')");
        assert!(result.starts_with("```python\n"));
        assert!(result.contains("print('hello')"));
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

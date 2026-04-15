//! Diff parser module
//!
//! Parses unified diff output from `git diff` into structured data
//! for the built-in diff review UI.

use serde::Serialize;

use crate::error::Result;
use crate::git;

/// A single line in a diff hunk
#[derive(Debug, Clone, Serialize)]
pub struct DiffLine {
    /// Line type: "context", "insert", "delete"
    pub line_type: String,
    /// Line number in old file (None for inserted lines)
    pub old_line: Option<u32>,
    /// Line number in new file (None for deleted lines)
    pub new_line: Option<u32>,
    /// Line content (without the leading +/-/space)
    pub content: String,
}

/// A hunk (section) within a diff file
#[derive(Debug, Clone, Serialize)]
pub struct DiffHunk {
    pub old_start: u32,
    pub old_lines: u32,
    pub new_start: u32,
    pub new_lines: u32,
    pub header: String,
    pub lines: Vec<DiffLine>,
}

/// A single file's diff
#[derive(Debug, Clone, Serialize)]
pub struct DiffFile {
    pub old_path: String,
    pub new_path: String,
    /// Change type: "added", "modified", "deleted", "renamed"
    pub change_type: String,
    pub hunks: Vec<DiffHunk>,
    pub is_binary: bool,
    pub additions: u32,
    pub deletions: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_untracked: Option<bool>,
}

/// Complete diff result across all files
#[derive(Debug, Clone, Serialize)]
pub struct DiffResult {
    pub files: Vec<DiffFile>,
    pub total_additions: u32,
    pub total_deletions: u32,
}

/// Parse raw unified diff output into structured DiffResult
pub fn parse_diff(raw: &str) -> DiffResult {
    let mut files = Vec::new();
    let mut total_additions = 0u32;
    let mut total_deletions = 0u32;

    // Split by "diff --git" boundaries
    let file_chunks: Vec<&str> = raw.split("\ndiff --git ").collect();

    for (i, chunk) in file_chunks.iter().enumerate() {
        let chunk = if i == 0 {
            // First chunk might start with "diff --git "
            chunk.strip_prefix("diff --git ").unwrap_or(chunk)
        } else {
            chunk
        };

        if chunk.trim().is_empty() {
            continue;
        }

        if let Some(file) = parse_file_diff(chunk) {
            total_additions += file.additions;
            total_deletions += file.deletions;
            files.push(file);
        }
    }

    DiffResult {
        files,
        total_additions,
        total_deletions,
    }
}

/// Parse a single file's diff section
fn parse_file_diff(chunk: &str) -> Option<DiffFile> {
    let mut lines = chunk.lines();

    // First line: "a/path b/path"
    let header_line = lines.next()?;
    let (old_path, new_path) = parse_diff_paths(header_line)?;

    let mut change_type = "modified".to_string();
    let mut is_binary = false;
    let mut hunks = Vec::new();
    let mut additions = 0u32;
    let mut deletions = 0u32;

    // Collect remaining lines
    let remaining: Vec<&str> = lines.collect();
    let mut idx = 0;

    while idx < remaining.len() {
        let line = remaining[idx];

        if line.starts_with("new file mode") {
            change_type = "added".to_string();
        } else if line.starts_with("deleted file mode") {
            change_type = "deleted".to_string();
        } else if line.starts_with("rename from") || line.starts_with("similarity index") {
            change_type = "renamed".to_string();
        } else if line.contains("Binary files") || line.starts_with("Binary files") {
            is_binary = true;
        } else if line.starts_with("@@") {
            // Parse hunk
            if let Some((hunk, consumed)) = parse_hunk(&remaining[idx..]) {
                additions += hunk
                    .lines
                    .iter()
                    .filter(|l| l.line_type == "insert")
                    .count() as u32;
                deletions += hunk
                    .lines
                    .iter()
                    .filter(|l| l.line_type == "delete")
                    .count() as u32;
                hunks.push(hunk);
                idx += consumed;
                continue;
            }
        }

        idx += 1;
    }

    Some(DiffFile {
        old_path,
        new_path,
        change_type,
        hunks,
        is_binary,
        additions,
        deletions,
        is_untracked: None,
    })
}

/// Unquote a git-quoted path: strip surrounding quotes and decode `\NNN` octal escapes to UTF-8.
/// Git quotes paths containing non-ASCII or special chars as `"path/\350\203\275.md"`.
fn unquote_git_path(s: &str) -> String {
    let inner = s
        .strip_prefix('"')
        .and_then(|s| s.strip_suffix('"'))
        .unwrap_or(s);
    let mut bytes = Vec::with_capacity(inner.len());
    let mut chars = inner.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\\' {
            // Check for octal escape: 1-3 octal digits
            if chars.peek().is_some_and(|&d| ('0'..='3').contains(&d)) {
                let mut val: u8 = 0;
                for _ in 0..3 {
                    if let Some(&d) = chars.peek() {
                        if d.is_ascii_digit() && d <= '7' {
                            val = val * 8 + (d as u8 - b'0');
                            chars.next();
                        } else {
                            break;
                        }
                    }
                }
                bytes.push(val);
            } else {
                // Other escape sequences: \n, \t, \\, \"
                match chars.next() {
                    Some('n') => bytes.push(b'\n'),
                    Some('t') => bytes.push(b'\t'),
                    Some('\\') => bytes.push(b'\\'),
                    Some('"') => bytes.push(b'"'),
                    Some(other) => {
                        bytes.push(b'\\');
                        let mut buf = [0u8; 4];
                        bytes.extend_from_slice(other.encode_utf8(&mut buf).as_bytes());
                    }
                    None => bytes.push(b'\\'),
                }
            }
        } else {
            let mut buf = [0u8; 4];
            bytes.extend_from_slice(c.encode_utf8(&mut buf).as_bytes());
        }
    }
    String::from_utf8(bytes).unwrap_or_else(|e| String::from_utf8_lossy(e.as_bytes()).into_owned())
}

/// Parse "a/path b/path" from the diff header
fn parse_diff_paths(line: &str) -> Option<(String, String)> {
    // Git may quote paths with non-ASCII chars: "a/\350\203\275.md" "b/\350\203\275.md"
    // Detect quoted format: starts with "a/ or "a/
    if line.starts_with('"') {
        // Quoted format: "a/old" "b/new"
        let parts: Vec<&str> = line.splitn(2, "\" \"").collect();
        if parts.len() == 2 {
            let old_raw = format!("{}\"", parts[0]); // restore trailing quote
            let new_raw = format!("\"{}", parts[1]); // restore leading quote
            let old = unquote_git_path(&old_raw);
            let new_path = unquote_git_path(&new_raw);
            let old = old.strip_prefix("a/").unwrap_or(&old).to_string();
            let new_path = new_path.strip_prefix("b/").unwrap_or(&new_path).to_string();
            return Some((old, new_path));
        }
    }

    // Unquoted format: a/foo/bar.rs b/foo/bar.rs
    // Handle paths with spaces by finding the " b/" separator
    let parts: Vec<&str> = line.splitn(2, " b/").collect();
    if parts.len() == 2 {
        let old = parts[0].strip_prefix("a/").unwrap_or(parts[0]);
        let new_path = parts[1];
        Some((old.to_string(), new_path.to_string()))
    } else {
        // Fallback: split on space
        let parts: Vec<&str> = line.split_whitespace().collect();
        if parts.len() >= 2 {
            let old = parts[0].strip_prefix("a/").unwrap_or(parts[0]);
            let new_path = parts[1].strip_prefix("b/").unwrap_or(parts[1]);
            Some((old.to_string(), new_path.to_string()))
        } else {
            None
        }
    }
}

/// Parse a single hunk starting from an @@ line.
/// Returns (DiffHunk, lines_consumed).
fn parse_hunk(lines: &[&str]) -> Option<(DiffHunk, usize)> {
    let header = lines.first()?;
    if !header.starts_with("@@") {
        return None;
    }

    // Parse "@@ -old_start,old_lines +new_start,new_lines @@ optional context"
    let (old_start, old_lines, new_start, new_lines) = parse_hunk_header(header)?;

    let mut diff_lines = Vec::new();
    let mut old_line = old_start;
    let mut new_line = new_start;
    let mut consumed = 1; // the @@ line itself

    for line in &lines[1..] {
        if line.starts_with("@@") || line.starts_with("diff --git ") {
            break;
        }

        consumed += 1;

        if let Some(content) = line.strip_prefix('+') {
            diff_lines.push(DiffLine {
                line_type: "insert".to_string(),
                old_line: None,
                new_line: Some(new_line),
                content: content.to_string(),
            });
            new_line += 1;
        } else if let Some(content) = line.strip_prefix('-') {
            diff_lines.push(DiffLine {
                line_type: "delete".to_string(),
                old_line: Some(old_line),
                new_line: None,
                content: content.to_string(),
            });
            old_line += 1;
        } else if line.starts_with('\\') {
            // "\ No newline at end of file" — skip
        } else {
            // Context line (starts with ' ' or is empty line in diff)
            let content = line.strip_prefix(' ').unwrap_or(line);
            diff_lines.push(DiffLine {
                line_type: "context".to_string(),
                old_line: Some(old_line),
                new_line: Some(new_line),
                content: content.to_string(),
            });
            old_line += 1;
            new_line += 1;
        }
    }

    Some((
        DiffHunk {
            old_start,
            old_lines,
            new_start,
            new_lines,
            header: header.to_string(),
            lines: diff_lines,
        },
        consumed,
    ))
}

/// Parse the "@@ -start,lines +start,lines @@" header
fn parse_hunk_header(header: &str) -> Option<(u32, u32, u32, u32)> {
    // Find the range between @@ markers
    let after_at = header.strip_prefix("@@ ")?;
    let range_end = after_at.find(" @@")?;
    let range_str = &after_at[..range_end];

    // Split "-old +new"
    let parts: Vec<&str> = range_str.split_whitespace().collect();
    if parts.len() < 2 {
        return None;
    }

    let old_part = parts[0].strip_prefix('-')?;
    let new_part = parts[1].strip_prefix('+')?;

    let (old_start, old_lines) = parse_range(old_part);
    let (new_start, new_lines) = parse_range(new_part);

    Some((old_start, old_lines, new_start, new_lines))
}

/// Parse "start,lines" or just "start" (implies lines=1)
fn parse_range(s: &str) -> (u32, u32) {
    if let Some((start, lines)) = s.split_once(',') {
        (start.parse().unwrap_or(1), lines.parse().unwrap_or(1))
    } else {
        (s.parse().unwrap_or(1), 1)
    }
}

/// Get diff for a single file
///
/// Handles both tracked and untracked files.
/// For untracked files, diffs against /dev/null using `git diff --no-index`.
pub fn get_single_file_diff(
    worktree_path: &str,
    file_path: &str,
    from_ref: Option<&str>,
    to_ref: Option<&str>,
) -> Result<DiffFile> {
    let is_untracked = git::git_cmd(
        worktree_path,
        &[
            "ls-files",
            "--others",
            "--exclude-standard",
            "--",
            file_path,
        ],
    )
    .map(|out| !out.trim().is_empty())
    .unwrap_or(false);

    let raw = if is_untracked {
        git::git_cmd_allow_exit1(
            worktree_path,
            &["diff", "--no-index", "-U3", "--", "/dev/null", file_path],
        )?
    } else if let Some(to) = to_ref {
        let range = format!("{}..{}", from_ref.unwrap_or("HEAD"), to);
        git::git_cmd(worktree_path, &["diff", "-U3", &range, "--", file_path])?
    } else {
        git::git_cmd(
            worktree_path,
            &["diff", "-U3", from_ref.unwrap_or("HEAD"), "--", file_path],
        )?
    };

    let mut result = parse_diff(&raw);
    result
        .files
        .retain(|f| f.new_path == file_path || f.old_path == file_path);

    match result.files.into_iter().next() {
        Some(mut file) => {
            file.is_untracked = Some(is_untracked);
            Ok(file)
        }
        None => Ok(DiffFile {
            old_path: file_path.to_string(),
            new_path: file_path.to_string(),
            change_type: if is_untracked { "added" } else { "modified" }.to_string(),
            hunks: vec![],
            is_binary: false,
            additions: 0,
            deletions: 0,
            is_untracked: Some(is_untracked),
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_hunk_header() {
        let result = parse_hunk_header("@@ -10,5 +10,7 @@ fn main()");
        assert_eq!(result, Some((10, 5, 10, 7)));
    }

    #[test]
    fn test_parse_hunk_header_single_line() {
        let result = parse_hunk_header("@@ -1 +1 @@");
        assert_eq!(result, Some((1, 1, 1, 1)));
    }

    #[test]
    fn test_parse_diff_paths() {
        let result = parse_diff_paths("a/src/main.rs b/src/main.rs");
        assert_eq!(
            result,
            Some(("src/main.rs".to_string(), "src/main.rs".to_string()))
        );
    }

    #[test]
    fn test_parse_simple_diff() {
        let raw = r#"diff --git a/src/main.rs b/src/main.rs
index abc1234..def5678 100644
--- a/src/main.rs
+++ b/src/main.rs
@@ -1,3 +1,4 @@
 fn main() {
-    println!("hello");
+    println!("hello world");
+    println!("goodbye");
 }
"#;
        let result = parse_diff(raw);
        assert_eq!(result.files.len(), 1);
        assert_eq!(result.total_additions, 2);
        assert_eq!(result.total_deletions, 1);

        let file = &result.files[0];
        assert_eq!(file.new_path, "src/main.rs");
        assert_eq!(file.change_type, "modified");
        assert_eq!(file.hunks.len(), 1);
        assert_eq!(file.hunks[0].lines.len(), 5);
    }

    #[test]
    fn test_parse_new_file() {
        let raw = r#"diff --git a/new.txt b/new.txt
new file mode 100644
index 0000000..abc1234
--- /dev/null
+++ b/new.txt
@@ -0,0 +1,2 @@
+line 1
+line 2
"#;
        let result = parse_diff(raw);
        assert_eq!(result.files.len(), 1);
        assert_eq!(result.files[0].change_type, "added");
        assert_eq!(result.files[0].additions, 2);
    }

    #[test]
    fn test_parse_binary() {
        let raw = r#"diff --git a/image.png b/image.png
Binary files a/image.png and b/image.png differ
"#;
        let result = parse_diff(raw);
        assert_eq!(result.files.len(), 1);
        assert!(result.files[0].is_binary);
    }

    #[test]
    fn test_parse_deleted_file() {
        let raw = r#"diff --git a/old.txt b/old.txt
deleted file mode 100644
index abc1234..0000000
--- a/old.txt
+++ /dev/null
@@ -1,2 +0,0 @@
-line 1
-line 2
"#;
        let result = parse_diff(raw);
        assert_eq!(result.files.len(), 1);
        assert_eq!(result.files[0].change_type, "deleted");
        assert_eq!(result.files[0].deletions, 2);
    }

    #[test]
    fn test_parse_multiple_files() {
        let raw = r#"diff --git a/foo.rs b/foo.rs
index abc..def 100644
--- a/foo.rs
+++ b/foo.rs
@@ -1,2 +1,3 @@
 line1
+added
 line2
diff --git a/bar.rs b/bar.rs
index abc..def 100644
--- a/bar.rs
+++ b/bar.rs
@@ -1,3 +1,2 @@
 line1
-removed
 line3
"#;
        let result = parse_diff(raw);
        assert_eq!(result.files.len(), 2);
        assert_eq!(result.total_additions, 1);
        assert_eq!(result.total_deletions, 1);
    }

    #[test]
    fn test_unquote_git_path_ascii() {
        assert_eq!(unquote_git_path("simple.txt"), "simple.txt");
        assert_eq!(unquote_git_path("\"quoted.txt\""), "quoted.txt");
    }

    #[test]
    fn test_unquote_git_path_chinese() {
        // \350\203\275\345\212\233 = "能力" in UTF-8 octal
        let quoted = r#""\350\203\275\345\212\233.md""#;
        assert_eq!(unquote_git_path(quoted), "能力.md");
    }

    #[test]
    fn test_parse_diff_paths_quoted() {
        let line = r#""a/docs/\350\203\275.md" "b/docs/\350\203\275.md""#;
        let (old, new) = parse_diff_paths(line).unwrap();
        assert_eq!(old, "docs/能.md");
        assert_eq!(new, "docs/能.md");
    }
}

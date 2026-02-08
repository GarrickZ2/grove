//! MCP Server implementation for Grove
//!
//! Provides MCP tools for AI agents to interact with Grove tasks:
//! - grove_status: Check if running inside a Grove task
//! - grove_read_notes: Read user-written notes
//! - grove_read_review: Read review comments
//! - grove_reply_review: Reply to review comments
//! - grove_complete_task: Complete task (commit, sync, merge)

use std::env;

use rmcp::{
    handler::server::{tool::ToolRouter, wrapper::Parameters},
    model::*,
    schemars,
    schemars::JsonSchema,
    tool, tool_handler, tool_router, ErrorData as McpError, ServerHandler, ServiceExt,
};
use serde::{Deserialize, Serialize};

use crate::git;
use crate::storage::{comments, notes, workspace::project_hash};

// ============================================================================
// Grove Instructions for AI
// ============================================================================

const GROVE_INSTRUCTIONS: &str = r#"
# Grove - Git Worktree Task Manager

Grove is a TUI application that manages parallel development tasks using Git worktrees and tmux sessions.

## What is a Grove Task?

A Grove "task" represents an isolated development environment:
- Each task has its own Git worktree (branch + working directory)
- Each task runs in a dedicated tmux session
- Tasks are isolated from each other, allowing parallel work

## How to Detect Grove Environment

**IMPORTANT**: Before using any Grove tools, first call `grove_status` to check if you are running inside a Grove task.

- If `in_grove_task` is `true`: You are in a Grove task, and you can use all Grove tools.
- If `in_grove_task` is `false`: You are NOT in a Grove task. Do NOT use other Grove tools as they will fail.

## Available Tools

When inside a Grove task:

1. **grove_status** - Get task context (task_id, branch, target_branch, project)
2. **grove_read_notes** - Read user-written notes containing context and requirements
3. **grove_read_review** - Read code review comments with IDs and status
4. **grove_reply_review** - Reply to review comments (supports batch)
5. **grove_add_comment** - Create a code review comment to provide feedback, raise questions, or suggest improvements on specific code locations
6. **grove_complete_task** - Complete task: commit → sync (rebase) → merge. **ONLY call when the user explicitly asks.**

## Recommended Workflow

1. Call `grove_status` first to verify you are in a Grove task
2. Call `grove_read_notes` to understand user requirements and context
3. Call `grove_read_review` to check for code review feedback
4. After addressing review comments, use `grove_reply_review` to respond
5. When the user explicitly requests, call `grove_complete_task` to finalize

## Completing a Task

**IMPORTANT**: ONLY call `grove_complete_task` when the user explicitly asks you to complete the task. NEVER call it automatically or proactively.
- Provide a commit message summarizing your changes
- The tool will: commit → fetch & rebase target → merge into target branch
- If rebase conflicts occur, resolve them and call `grove_complete_task` again

## When NOT in Grove

If `grove_status` returns `in_grove_task: false`, inform the user:
"I'm not running inside a Grove task environment. Grove tools are only available when working within a Grove-managed tmux session. Please start a task from the Grove TUI."
"#;

/// Grove MCP Server
#[derive(Clone)]
pub struct GroveMcpServer {
    #[allow(dead_code)]
    tool_router: ToolRouter<Self>,
}

impl GroveMcpServer {
    pub fn new() -> Self {
        Self {
            tool_router: Self::tool_router(),
        }
    }
}

impl Default for GroveMcpServer {
    fn default() -> Self {
        Self::new()
    }
}

#[tool_handler(router = self.tool_router)]
impl ServerHandler for GroveMcpServer {
    fn get_info(&self) -> ServerInfo {
        ServerInfo {
            protocol_version: ProtocolVersion::LATEST,
            capabilities: ServerCapabilities::builder().enable_tools().build(),
            server_info: Implementation {
                name: "grove".to_string(),
                version: env!("CARGO_PKG_VERSION").to_string(),
                title: Some("Grove MCP Server".to_string()),
                website_url: Some("https://github.com/GarrickZ2/grove".to_string()),
                icons: None,
            },
            instructions: Some(GROVE_INSTRUCTIONS.to_string()),
        }
    }
}

// ============================================================================
// Tool Parameter Types
// ============================================================================

/// Single reply to a review comment
#[derive(Debug, Serialize, Deserialize, JsonSchema)]
pub struct SingleReply {
    /// The comment ID to reply to
    pub comment_id: u32,
    /// Your reply message
    pub message: String,
    /// Author name (e.g., "Claude Code Reviewer")
    pub author: Option<String>,
}

/// Batch reply parameters - reply to multiple comments at once
#[derive(Debug, Serialize, Deserialize, JsonSchema)]
pub struct ReplyReviewParams {
    /// List of replies to send
    pub replies: Vec<SingleReply>,
}

/// Add comment parameters
#[derive(Debug, Serialize, Deserialize, JsonSchema)]
pub struct AddCommentParams {
    /// File path (e.g., "src/main.rs")
    pub file_path: String,
    /// Start line number (1-based)
    pub start_line: u32,
    /// End line number (1-based). Defaults to start_line if omitted.
    pub end_line: Option<u32>,
    /// Comment content
    pub content: String,
    /// Author name (e.g., "Claude Code Reviewer")
    pub author: Option<String>,
}

/// Complete task parameters
#[derive(Debug, Serialize, Deserialize, JsonSchema)]
pub struct CompleteTaskParams {
    /// Commit message for the changes
    pub commit_message: String,
}

// ============================================================================
// Tool Response Types
// ============================================================================

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
pub struct StatusResult {
    /// Whether running inside a Grove task
    pub in_grove_task: bool,
    /// Task ID (slug)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub task_id: Option<String>,
    /// Human-readable task name
    #[serde(skip_serializing_if = "Option::is_none")]
    pub task_name: Option<String>,
    /// Current branch
    #[serde(skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    /// Target branch for merge
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target: Option<String>,
    /// Project name
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
pub struct CompleteTaskResult {
    /// Whether the operation succeeded
    pub success: bool,
    /// Error type if failed
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// Commit hash if committed
    #[serde(skip_serializing_if = "Option::is_none")]
    pub commit_hash: Option<String>,
    /// List of conflict files if rebase conflict
    #[serde(skip_serializing_if = "Option::is_none")]
    pub conflicts: Option<Vec<String>>,
    /// Human-readable message
    pub message: String,
}

// ============================================================================
// Tool Implementations
// ============================================================================

#[tool_router]
impl GroveMcpServer {
    /// Check if running inside a Grove task and get task context
    #[tool(
        name = "grove_status",
        description = "CALL THIS FIRST before using any other Grove tools. Checks if you are running inside a Grove task environment. Returns task context including task_id, branch name, target branch, and project name. If in_grove_task is false, do NOT use other Grove tools."
    )]
    async fn grove_status(&self) -> Result<CallToolResult, McpError> {
        let result = match get_task_context() {
            Some((task_id, _project_path)) => StatusResult {
                in_grove_task: true,
                task_id: Some(task_id),
                task_name: env::var("GROVE_TASK_NAME").ok(),
                branch: env::var("GROVE_BRANCH").ok(),
                target: env::var("GROVE_TARGET").ok(),
                project: env::var("GROVE_PROJECT_NAME").ok(),
            },
            None => StatusResult {
                in_grove_task: false,
                task_id: None,
                task_name: None,
                branch: None,
                target: None,
                project: None,
            },
        };

        let json = serde_json::to_string_pretty(&result)
            .map_err(|e| McpError::internal_error(e.to_string(), None))?;
        Ok(CallToolResult::success(vec![Content::text(json)]))
    }

    /// Read user-written notes for the current task
    #[tool(
        name = "grove_read_notes",
        description = "Read user-written notes for the current Grove task. Notes contain important context, requirements, and instructions set by the user. Call grove_status first to ensure you are in a Grove task."
    )]
    async fn grove_read_notes(&self) -> Result<CallToolResult, McpError> {
        let (task_id, project_path) = get_task_context()
            .ok_or_else(|| McpError::invalid_request("Not in a Grove task", None))?;

        let project_key = project_hash(&project_path);

        match notes::load_notes(&project_key, &task_id) {
            Ok(content) if content.is_empty() => Ok(CallToolResult::success(vec![Content::text(
                "No notes yet.",
            )])),
            Ok(content) => Ok(CallToolResult::success(vec![Content::text(content)])),
            Err(e) => Err(McpError::internal_error(
                format!("Failed to read notes: {}", e),
                None,
            )),
        }
    }

    /// Read review comments for the current task
    #[tool(
        name = "grove_read_review",
        description = "Read code review comments for the current Grove task. Returns comments with IDs, locations, content, and status (open/resolved/outdated). Use grove_reply_review to respond to comments. Call grove_status first to ensure you are in a Grove task."
    )]
    async fn grove_read_review(&self) -> Result<CallToolResult, McpError> {
        let (task_id, project_path) = get_task_context()
            .ok_or_else(|| McpError::invalid_request("Not in a Grove task", None))?;

        let project_key = project_hash(&project_path);

        match comments::load_comments(&project_key, &task_id) {
            Ok(data) if data.is_empty() => Ok(CallToolResult::success(vec![Content::text(
                "No code review comments yet.",
            )])),
            Ok(mut data) => {
                // 动态检测 outdated
                let worktree = env::var("GROVE_WORKTREE").unwrap_or_default();
                let target = env::var("GROVE_TARGET").unwrap_or_default();
                if !worktree.is_empty() && !target.is_empty() {
                    comments::apply_outdated_detection(&mut data, |file_path, side| {
                        if side == "DELETE" {
                            git::show_file(&worktree, &target, file_path).ok()
                        } else {
                            git::read_file(&worktree, file_path).ok()
                        }
                    });
                }

                let output = format_comments(&data);
                Ok(CallToolResult::success(vec![Content::text(output)]))
            }
            Err(e) => Err(McpError::internal_error(
                format!("Failed to read comments: {}", e),
                None,
            )),
        }
    }

    /// Reply to review comments (supports batch)
    #[tool(
        name = "grove_reply_review",
        description = "Reply to one or more code review comments. Supports batch replies to reduce tool calls. Call grove_read_review first to get comment IDs."
    )]
    async fn grove_reply_review(
        &self,
        params: Parameters<ReplyReviewParams>,
    ) -> Result<CallToolResult, McpError> {
        let (task_id, project_path) = get_task_context()
            .ok_or_else(|| McpError::invalid_request("Not in a Grove task", None))?;

        let project_key = project_hash(&project_path);

        if params.0.replies.is_empty() {
            return Err(McpError::invalid_params(
                "replies array cannot be empty",
                None,
            ));
        }

        let mut results: Vec<String> = Vec::new();
        let mut errors: Vec<String> = Vec::new();

        for reply in &params.0.replies {
            let author = reply.author.as_deref().unwrap_or("AI");

            match comments::reply_comment(
                &project_key,
                &task_id,
                reply.comment_id,
                &reply.message,
                author,
            ) {
                Ok(true) => {
                    results.push(format!("#{}: replied ✓", reply.comment_id));
                }
                Ok(false) => {
                    errors.push(format!("#{}: not found", reply.comment_id));
                }
                Err(e) => {
                    errors.push(format!("#{}: error - {}", reply.comment_id, e));
                }
            }
        }

        let mut output = String::new();
        if !results.is_empty() {
            output.push_str(&format!("Replied to {} comment(s):\n", results.len()));
            for r in &results {
                output.push_str(&format!("  {}\n", r));
            }
        }
        if !errors.is_empty() {
            if !output.is_empty() {
                output.push('\n');
            }
            output.push_str(&format!("Errors ({}):\n", errors.len()));
            for e in &errors {
                output.push_str(&format!("  {}\n", e));
            }
        }

        if results.is_empty() && !errors.is_empty() {
            return Err(McpError::invalid_params(output.trim().to_string(), None));
        }

        Ok(CallToolResult::success(vec![Content::text(
            output.trim().to_string(),
        )]))
    }

    /// Add a new code review comment on the current task
    #[tool(
        name = "grove_add_comment",
        description = "Create a code review comment on specific code in the current Grove task. Use this when reviewing code to provide feedback, raise questions, or suggest improvements. The comment will appear in the diff review UI."
    )]
    async fn grove_add_comment(
        &self,
        params: Parameters<AddCommentParams>,
    ) -> Result<CallToolResult, McpError> {
        let (task_id, project_path) = get_task_context()
            .ok_or_else(|| McpError::invalid_request("Not in a Grove task", None))?;

        let project_key = project_hash(&project_path);

        let file_path = &params.0.file_path;
        let start_line = params.0.start_line;
        let end_line = params.0.end_line.unwrap_or(start_line);
        let author = params.0.author.as_deref().unwrap_or("AI");

        // 计算 anchor_text
        let anchor_text = {
            let worktree = env::var("GROVE_WORKTREE").unwrap_or_default();
            if !worktree.is_empty() {
                git::read_file(&worktree, file_path)
                    .ok()
                    .and_then(|c| comments::extract_lines(&c, start_line, end_line))
            } else {
                None
            }
        };

        match comments::add_comment(
            &project_key,
            &task_id,
            file_path,
            "ADD",
            start_line,
            end_line,
            &params.0.content,
            author,
            anchor_text,
        ) {
            Ok(comment) => {
                let loc = format!("{}:{}", comment.file_path, comment.start_line);
                let output = format!(
                    "Comment #{} added at {}\n> {}",
                    comment.id, loc, comment.content
                );
                Ok(CallToolResult::success(vec![Content::text(output)]))
            }
            Err(e) => Err(McpError::internal_error(
                format!("Failed to add comment: {}", e),
                None,
            )),
        }
    }

    /// Complete the current task: commit, sync (rebase), and merge
    #[tool(
        name = "grove_complete_task",
        description = "Complete the current Grove task in one operation. This will: (1) commit all changes with your message, (2) sync with target branch via rebase, (3) merge into target branch. If rebase conflicts occur, resolve them and call this tool again. IMPORTANT: ONLY call this tool when the user explicitly requests task completion. NEVER call it automatically or proactively. Call grove_status first to ensure you are in a Grove task."
    )]
    async fn grove_complete_task(
        &self,
        params: Parameters<CompleteTaskParams>,
    ) -> Result<CallToolResult, McpError> {
        let (task_id, project_path) = get_task_context()
            .ok_or_else(|| McpError::invalid_request("Not in a Grove task", None))?;

        // Get environment variables
        let worktree_path = env::var("GROVE_WORKTREE")
            .map_err(|_| McpError::internal_error("GROVE_WORKTREE not set", None))?;
        let target_branch = env::var("GROVE_TARGET")
            .map_err(|_| McpError::internal_error("GROVE_TARGET not set", None))?;
        let branch = env::var("GROVE_BRANCH")
            .map_err(|_| McpError::internal_error("GROVE_BRANCH not set", None))?;

        // Step 1: Check for uncommitted changes and commit if any
        let has_changes = git::has_uncommitted_changes(&worktree_path).map_err(|e| {
            McpError::internal_error(format!("Failed to check changes: {}", e), None)
        })?;

        let commit_hash = if has_changes {
            // git add -A
            if let Err(e) = std::process::Command::new("git")
                .current_dir(&worktree_path)
                .args(["add", "-A"])
                .output()
            {
                return Err(McpError::internal_error(
                    format!("git add failed: {}", e),
                    None,
                ));
            }

            // git commit
            if let Err(e) = git::commit(&worktree_path, &params.0.commit_message) {
                return Ok(CallToolResult::success(vec![Content::text(
                    serde_json::to_string_pretty(&CompleteTaskResult {
                        success: false,
                        error: Some("commit_failed".to_string()),
                        commit_hash: None,
                        conflicts: None,
                        message: format!("Commit failed: {}", e),
                    })
                    .unwrap(),
                )]));
            }

            Some(git::get_head_short(&worktree_path).unwrap_or_else(|_| "unknown".to_string()))
        } else {
            None
        };

        // Step 2: Fetch and rebase
        let origin_target = format!("origin/{}", target_branch);
        if let Err(e) = git::fetch_origin(&worktree_path, &target_branch) {
            // Fetch failure is not fatal, continue with local target
            eprintln!("Warning: fetch failed: {}", e);
        }

        if let Err(_e) = git::rebase(&worktree_path, &origin_target) {
            // Rebase failed - check for conflicts
            let conflicts = git::get_conflict_files(&worktree_path).unwrap_or_default();

            if !conflicts.is_empty() {
                // Abort rebase and return conflict info
                let _ = git::abort_rebase(&worktree_path);

                return Ok(CallToolResult::success(vec![Content::text(
                    serde_json::to_string_pretty(&CompleteTaskResult {
                        success: false,
                        error: Some("rebase_conflict".to_string()),
                        commit_hash,
                        conflicts: Some(conflicts),
                        message: "Rebase conflict detected. Please resolve conflicts and call grove_complete_task again.".to_string(),
                    }).unwrap()
                )]));
            }
        }

        // Step 3: Merge into target branch (in main repo)
        // First checkout target branch in main repo
        if let Err(e) = git::checkout(&project_path, &target_branch) {
            return Ok(CallToolResult::success(vec![Content::text(
                serde_json::to_string_pretty(&CompleteTaskResult {
                    success: false,
                    error: Some("checkout_failed".to_string()),
                    commit_hash,
                    conflicts: None,
                    message: format!("Failed to checkout target branch: {}", e),
                })
                .unwrap(),
            )]));
        }

        // Load notes for merge commit message (non-fatal)
        let project_key = project_hash(&project_path);
        let notes_content = notes::load_notes(&project_key, &task_id)
            .ok()
            .filter(|s| !s.trim().is_empty());

        // Merge with --no-ff
        let merge_title = format!("Merge branch '{}' into {}", branch, target_branch);
        let merge_message = git::build_commit_message(&merge_title, notes_content.as_deref());
        if let Err(e) = git::merge_no_ff(&project_path, &branch, &merge_message) {
            // Reset merge state
            let _ = git::reset_merge(&project_path);
            // Checkout back to original branch (best effort)
            let _ = git::checkout(&project_path, &branch);

            return Ok(CallToolResult::success(vec![Content::text(
                serde_json::to_string_pretty(&CompleteTaskResult {
                    success: false,
                    error: Some("merge_failed".to_string()),
                    commit_hash,
                    conflicts: None,
                    message: format!("Merge failed: {}", e),
                })
                .unwrap(),
            )]));
        }

        // Build success result
        let result = CompleteTaskResult {
            success: true,
            error: None,
            commit_hash,
            conflicts: None,
            message: "Task completed successfully. Branch merged into target.".to_string(),
        };

        let json = serde_json::to_string_pretty(&result)
            .map_err(|e| McpError::internal_error(e.to_string(), None))?;

        Ok(CallToolResult::success(vec![Content::text(json)]))
    }
}

// ============================================================================
// Helper Functions
// ============================================================================

/// Get task context from environment variables
fn get_task_context() -> Option<(String, String)> {
    let task_id = env::var("GROVE_TASK_ID").ok()?;
    let project_path = env::var("GROVE_PROJECT").ok()?;
    if task_id.is_empty() || project_path.is_empty() {
        return None;
    }
    Some((task_id, project_path))
}

/// Format comments for display
fn format_comments(data: &comments::CommentsData) -> String {
    let (open, resolved, outdated) = data.count_by_status();
    let mut output = format!(
        "Review Comments ({} open, {} resolved, {} outdated)\n\n",
        open, resolved, outdated
    );

    for comment in &data.comments {
        let loc = format!("{}:{}", comment.file_path, comment.start_line);
        match comment.status {
            comments::CommentStatus::Open => {
                output.push_str(&format!("[#{}] {}\n", comment.id, loc));
                output.push_str(&format!("> {}\n", comment.content));
                if comment.replies.is_empty() {
                    output.push_str("  (no reply)\n\n");
                } else {
                    for r in &comment.replies {
                        output.push_str(&format!("  {}: {}\n", r.author, r.content));
                    }
                    output.push('\n');
                }
            }
            comments::CommentStatus::Outdated => {
                output.push_str(&format!("[#{}] OUTDATED {}\n", comment.id, loc));
                output.push_str(&format!("> {}\n", comment.content));
                for r in &comment.replies {
                    output.push_str(&format!("  {}: {}\n", r.author, r.content));
                }
                output.push('\n');
            }
            comments::CommentStatus::Resolved => {
                output.push_str(&format!("[#{}] RESOLVED ~~{}~~\n", comment.id, loc));
                output.push_str(&format!("> ~~{}~~\n", comment.content));
                for r in &comment.replies {
                    output.push_str(&format!("  {}: {}\n", r.author, r.content));
                }
                output.push('\n');
            }
        }
    }

    output
}

// ============================================================================
// Server Entry Point
// ============================================================================

/// Run the MCP server with stdio transport
pub async fn run_mcp_server() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    use rmcp::transport::io::stdio;

    let server = GroveMcpServer::new();
    let transport = stdio();

    let service = server.serve(transport).await?;
    service.waiting().await?;

    Ok(())
}

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
5. **grove_add_comment** - Create review comments (supports batch). Three levels:
   - **Inline**: Comment on specific code lines (e.g., "extract this function")
   - **File**: Comment on entire file (e.g., "file too large, split modules")
   - **Project**: Overall feedback (e.g., "add integration tests")
   Use to review code, raise questions, suggest improvements, or **visualize implementation plans** by marking key points.
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
}

/// Batch reply parameters - reply to multiple comments at once
#[derive(Debug, Serialize, Deserialize, JsonSchema)]
pub struct ReplyReviewParams {
    /// List of replies to send
    pub replies: Vec<SingleReply>,
    /// Agent name (e.g., "Claude Code"). Combined with role to form full author name.
    pub agent_name: Option<String>,
    /// Role of the agent (e.g., "Reviewer", "Implementer"). Combined with agent_name.
    pub role: Option<String>,
}

/// Single comment item
#[derive(Debug, Serialize, Deserialize, JsonSchema)]
pub struct CommentItem {
    /// Type of comment: "inline", "file", or "project" (defaults to "inline")
    pub comment_type: Option<String>,
    /// File path (required for inline/file, omit for project)
    pub file_path: Option<String>,
    /// Start line number (required for inline only, 1-based)
    pub start_line: Option<u32>,
    /// End line number (required for inline only, 1-based). Defaults to start_line if omitted.
    pub end_line: Option<u32>,
    /// Comment content
    pub content: String,
}

/// Add comment parameters
#[derive(Debug, Serialize, Deserialize, JsonSchema)]
pub struct AddCommentParams {
    /// List of comments to create. Pass a single-element array to create one comment.
    pub comments: Vec<CommentItem>,
    /// Agent name (e.g., "Claude Code"). Combined with role to form full author name.
    pub agent_name: Option<String>,
    /// Role of the agent (e.g., "Reviewer", "Planner", "Implementer"). Combined with agent_name.
    pub role: Option<String>,
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

// --- Review JSON response types ---

#[derive(Debug, Serialize)]
struct ReviewReplyEntry {
    reply_id: u32,
    content: String,
    author: String,
}

#[derive(Debug, Serialize)]
struct ReviewCommentEntry {
    comment_id: u32,
    #[serde(rename = "type")]
    comment_type: String,
    status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    file_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    side: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    start_line: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    end_line: Option<u32>,
    content: String,
    author: String,
    replies: Vec<ReviewReplyEntry>,
}

#[derive(Debug, Serialize)]
struct ReadReviewResult {
    open_count: usize,
    resolved_count: usize,
    outdated_count: usize,
    comments: Vec<ReviewCommentEntry>,
}

#[derive(Debug, Serialize)]
struct CreatedCommentEntry {
    comment_id: u32,
    #[serde(rename = "type")]
    comment_type: String,
    location: String,
}

#[derive(Debug, Serialize)]
struct AddCommentResult {
    created: Vec<CreatedCommentEntry>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    errors: Vec<String>,
}

#[derive(Debug, Serialize)]
struct ReplyResultEntry {
    comment_id: u32,
    success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[derive(Debug, Serialize)]
struct ReplyReviewResult {
    replies: Vec<ReplyResultEntry>,
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

                let (open, resolved, outdated) = data.count_by_status();
                let result = ReadReviewResult {
                    open_count: open,
                    resolved_count: resolved,
                    outdated_count: outdated,
                    comments: data
                        .comments
                        .iter()
                        .filter(|c| c.status != comments::CommentStatus::Resolved)
                        .map(|c| ReviewCommentEntry {
                            comment_id: c.id,
                            comment_type: match c.comment_type {
                                comments::CommentType::Inline => "inline".to_string(),
                                comments::CommentType::File => "file".to_string(),
                                comments::CommentType::Project => "project".to_string(),
                            },
                            status: match c.status {
                                comments::CommentStatus::Open => "open".to_string(),
                                comments::CommentStatus::Resolved => "resolved".to_string(),
                                comments::CommentStatus::Outdated => "outdated".to_string(),
                            },
                            file_path: c.file_path.clone(),
                            side: c.side.clone(),
                            start_line: c.start_line,
                            end_line: c.end_line,
                            content: c.content.clone(),
                            author: c.author.clone(),
                            replies: c
                                .replies
                                .iter()
                                .map(|r| ReviewReplyEntry {
                                    reply_id: r.id,
                                    content: r.content.clone(),
                                    author: r.author.clone(),
                                })
                                .collect(),
                        })
                        .collect(),
                };

                let json = serde_json::to_string_pretty(&result)
                    .map_err(|e| McpError::internal_error(e.to_string(), None))?;
                Ok(CallToolResult::success(vec![Content::text(json)]))
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

        // Build author string: "agent_name (role)"
        let author = match (&params.0.agent_name, &params.0.role) {
            (Some(name), Some(role)) => format!("{} ({})", name, role),
            (Some(name), None) => name.clone(),
            (None, Some(role)) => format!("Claude Code ({})", role),
            (None, None) => "Claude Code".to_string(),
        };

        let mut reply_results: Vec<ReplyResultEntry> = Vec::new();

        for reply in &params.0.replies {
            match comments::reply_comment(
                &project_key,
                &task_id,
                reply.comment_id,
                &reply.message,
                &author,
            ) {
                Ok(true) => {
                    reply_results.push(ReplyResultEntry {
                        comment_id: reply.comment_id,
                        success: true,
                        error: None,
                    });
                }
                Ok(false) => {
                    reply_results.push(ReplyResultEntry {
                        comment_id: reply.comment_id,
                        success: false,
                        error: Some("comment not found".to_string()),
                    });
                }
                Err(e) => {
                    reply_results.push(ReplyResultEntry {
                        comment_id: reply.comment_id,
                        success: false,
                        error: Some(e.to_string()),
                    });
                }
            }
        }

        let all_failed = reply_results.iter().all(|r| !r.success);
        let result = ReplyReviewResult {
            replies: reply_results,
        };

        let json = serde_json::to_string_pretty(&result)
            .map_err(|e| McpError::internal_error(e.to_string(), None))?;

        if all_failed {
            return Err(McpError::invalid_params(json, None));
        }

        Ok(CallToolResult::success(vec![Content::text(json)]))
    }

    /// Add review comments. Supports three levels: inline (code lines), file (entire file),
    /// project (overall). Use for code review, questions, improvements, or visualizing plans.
    #[tool(
        name = "grove_add_comment",
        description = "Create review comments. Three levels: 'inline' (specific lines), 'file' (entire file), 'project' (overall feedback). Use for code review, raising questions, suggesting improvements, or visualizing implementation plans by marking key points. Pass array with one item to create single comment, multiple items for batch."
    )]
    async fn grove_add_comment(
        &self,
        params: Parameters<AddCommentParams>,
    ) -> Result<CallToolResult, McpError> {
        let (task_id, project_path) = get_task_context()
            .ok_or_else(|| McpError::invalid_request("Not in a Grove task", None))?;

        let project_key = project_hash(&project_path);
        let worktree = env::var("GROVE_WORKTREE").unwrap_or_default();

        // Build author string: "agent_name (role)"
        let author = match (&params.0.agent_name, &params.0.role) {
            (Some(name), Some(role)) => format!("{} ({})", name, role),
            (Some(name), None) => name.clone(),
            (None, Some(role)) => format!("Claude Code ({})", role),
            (None, None) => "Claude Code".to_string(),
        };

        let mut created = Vec::new();
        let mut errors = Vec::new();

        // Process each comment
        for (idx, item) in params.0.comments.iter().enumerate() {
            // Parse comment type
            let comment_type = match item.comment_type.as_deref() {
                Some("file") => comments::CommentType::File,
                Some("project") => comments::CommentType::Project,
                _ => comments::CommentType::Inline,
            };

            // Prepare parameters and create comment based on type
            let result: Result<comments::Comment, String> = match comment_type {
                comments::CommentType::Inline => {
                    match (item.file_path.as_ref(), item.start_line) {
                        (Some(file_path), Some(start)) => {
                            let end = item.end_line.unwrap_or(start);

                            // Calculate anchor text
                            let anchor = if !worktree.is_empty() {
                                git::read_file(&worktree, file_path)
                                    .ok()
                                    .and_then(|c| comments::extract_lines(&c, start, end))
                            } else {
                                None
                            };

                            comments::add_comment(
                                &project_key,
                                &task_id,
                                comment_type,
                                Some(file_path.clone()),
                                Some("ADD".to_string()),
                                Some(start),
                                Some(end),
                                &item.content,
                                &author,
                                anchor,
                            )
                            .map_err(|e| e.to_string())
                        }
                        (None, _) => Err("file_path required for inline comments".to_string()),
                        (_, None) => Err("start_line required for inline comments".to_string()),
                    }
                }
                comments::CommentType::File => match item.file_path.as_ref() {
                    Some(file_path) => comments::add_comment(
                        &project_key,
                        &task_id,
                        comment_type,
                        Some(file_path.clone()),
                        None,
                        None,
                        None,
                        &item.content,
                        &author,
                        None,
                    )
                    .map_err(|e| e.to_string()),
                    None => Err("file_path required for file comments".to_string()),
                },
                comments::CommentType::Project => comments::add_comment(
                    &project_key,
                    &task_id,
                    comment_type,
                    None,
                    None,
                    None,
                    None,
                    &item.content,
                    &author,
                    None,
                )
                .map_err(|e| e.to_string()),
            };

            match result {
                Ok(comment) => {
                    let type_str = match comment.comment_type {
                        comments::CommentType::Inline => "inline",
                        comments::CommentType::File => "file",
                        comments::CommentType::Project => "project",
                    };
                    let location = match comment.comment_type {
                        comments::CommentType::Inline => {
                            let fp = comment.file_path.as_deref().unwrap_or("");
                            let sl = comment.start_line.unwrap_or(0);
                            let el = comment.end_line.unwrap_or(0);
                            format!("{}:{}-{}", fp, sl, el)
                        }
                        comments::CommentType::File => {
                            format!("File: {}", comment.file_path.as_deref().unwrap_or(""))
                        }
                        comments::CommentType::Project => "Project-level".to_string(),
                    };
                    created.push(CreatedCommentEntry {
                        comment_id: comment.id,
                        comment_type: type_str.to_string(),
                        location,
                    });
                }
                Err(e) => {
                    errors.push(format!("Comment #{}: {}", idx + 1, e));
                }
            }
        }

        let result = AddCommentResult { created, errors };

        let json = serde_json::to_string_pretty(&result)
            .map_err(|e| McpError::internal_error(e.to_string(), None))?;

        if result.created.is_empty() && !result.errors.is_empty() {
            return Err(McpError::invalid_params(json, None));
        }

        Ok(CallToolResult::success(vec![Content::text(json)]))
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

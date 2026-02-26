//! MCP Server implementation for Grove
//!
//! Provides MCP tools for AI agents to interact with Grove tasks:
//! - grove_status: Check if running inside a Grove task
//! - grove_read_notes: Read user-written notes
//! - grove_read_review: Read review comments
//! - grove_reply_review: Reply to review comments
//! - grove_complete_task: Complete task (commit, sync, merge)

use std::{collections::HashSet, env};

use rmcp::{
    handler::server::{tool::ToolRouter, wrapper::Parameters},
    model::*,
    schemars,
    schemars::JsonSchema,
    tool, tool_router, ErrorData as McpError, ServerHandler, ServiceExt,
};
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::git;
use crate::operations;
use crate::storage::{comments, config, notes, tasks, workspace};

// ============================================================================
// Grove Instructions for AI
// ============================================================================

const MANAGEMENT_INSTRUCTIONS: &str = r#"
# Grove - Project & Task Management

Use these tools for workspace-level project/task management before starting a Grove task (register/list projects, create/list tasks).

## Available Tools
1. **grove_list_projects** - List registered projects (supports query)
2. **grove_add_project_by_path** - Register a project by local path (idempotent)
3. **grove_create_task** - Create a task/worktree under a project
4. **grove_list_tasks** - List active tasks under a project (supports query)

## Recommended Workflow
1. Call `grove_list_projects` to find the target project
2. If missing, call `grove_add_project_by_path` to register it
3. Call `grove_create_task` to create a task for the project
4. Call `grove_list_tasks` to confirm the task is active

"#;

const EXECUTION_INSTRUCTIONS: &str = r#"
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

fn get_instructions() -> &'static str {
    if get_task_context().is_some() {
        EXECUTION_INSTRUCTIONS
    } else {
        MANAGEMENT_INSTRUCTIONS
    }
}

fn filter_tools(all: Vec<Tool>) -> Vec<Tool> {
    let task_scoped_tools: HashSet<&'static str> = HashSet::from([
        "grove_status",
        "grove_read_notes",
        "grove_read_review",
        "grove_reply_review",
        "grove_add_comment",
        "grove_complete_task",
    ]);
    if get_task_context().is_some() {
        all.into_iter()
            .filter(|t| task_scoped_tools.contains(t.name.as_ref()))
            .collect()
    } else {
        all.into_iter()
            .filter(|t| !task_scoped_tools.contains(t.name.as_ref()))
            .collect()
    }
}

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
            instructions: Some(get_instructions().to_string()),
        }
    }

    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        context: rmcp::service::RequestContext<rmcp::RoleServer>,
    ) -> Result<CallToolResult, McpError> {
        let tcc = rmcp::handler::server::tool::ToolCallContext::new(self, request, context);
        self.tool_router.call(tcc).await
    }

    async fn list_tools(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: rmcp::service::RequestContext<rmcp::RoleServer>,
    ) -> Result<ListToolsResult, McpError> {
        Ok(ListToolsResult {
            tools: filter_tools(self.tool_router.list_all()),
            meta: None,
            next_cursor: None,
        })
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

/// Add project by local path (workspace-scoped)
#[derive(Debug, Serialize, Deserialize, JsonSchema)]
pub struct AddProjectByPathParams {
    /// Local filesystem path to a git repository (or a subdirectory within it)
    pub path: String,
}

/// List registered projects (workspace-scoped)
#[derive(Debug, Serialize, Deserialize, JsonSchema)]
pub struct ListProjectsParams {
    /// Optional fuzzy query for filtering by project path
    pub query: Option<String>,
}

/// Create task under a project (workspace-scoped)
#[derive(Debug, Serialize, Deserialize, JsonSchema)]
pub struct CreateTaskParams {
    /// Project ID (hash)
    pub project_id: String,
    /// Human-readable task name
    pub name: String,
}

/// List active tasks under a project (workspace-scoped)
#[derive(Debug, Serialize, Deserialize, JsonSchema)]
pub struct ListTasksParams {
    /// Project ID (hash)
    pub project_id: String,
    /// Optional fuzzy query for filtering tasks
    pub query: Option<String>,
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

    /// Register a project by local path (idempotent)
    #[tool(
        name = "grove_add_project_by_path",
        description = "Register a Git project by local path. Path can be a repo root or a subdirectory. Returns project_id and normalized repo path. If the project already exists, this tool succeeds idempotently."
    )]
    async fn grove_add_project_by_path(
        &self,
        params: Parameters<AddProjectByPathParams>,
    ) -> Result<CallToolResult, McpError> {
        ensure_not_in_grove_task()?;
        ok_json(add_project_by_path_json(&params.0.path))
    }

    /// List all registered projects
    #[tool(
        name = "grove_list_projects",
        description = "List all registered projects. Returns an array of {project_id, path}. Optional fuzzy filter by query."
    )]
    async fn grove_list_projects(
        &self,
        params: Parameters<ListProjectsParams>,
    ) -> Result<CallToolResult, McpError> {
        ensure_not_in_grove_task()?;
        ok_json(list_projects_json(params.0.query.as_deref()))
    }

    /// Create a task/worktree under a project (does NOT start tmux/zellij session)
    #[tool(
        name = "grove_create_task",
        description = "Create a new task (git worktree + metadata) under a project. Does NOT create a tmux/zellij session."
    )]
    async fn grove_create_task(
        &self,
        params: Parameters<CreateTaskParams>,
    ) -> Result<CallToolResult, McpError> {
        ensure_not_in_grove_task()?;
        ok_json(create_task_json(&params.0))
    }

    /// List active tasks under a project
    #[tool(
        name = "grove_list_tasks",
        description = "List active tasks under a project. Returns task metadata only (no expensive git status computation)."
    )]
    async fn grove_list_tasks(
        &self,
        params: Parameters<ListTasksParams>,
    ) -> Result<CallToolResult, McpError> {
        ensure_not_in_grove_task()?;
        ok_json(list_tasks_json(
            &params.0.project_id,
            params.0.query.as_deref(),
        ))
    }

    /// Read user-written notes for the current task
    #[tool(
        name = "grove_read_notes",
        description = "Read user-written notes for the current Grove task. Notes contain important context, requirements, and instructions set by the user. Call grove_status first to ensure you are in a Grove task."
    )]
    async fn grove_read_notes(&self) -> Result<CallToolResult, McpError> {
        let (task_id, project_path) = get_task_context()
            .ok_or_else(|| McpError::invalid_request("Not in a Grove task", None))?;

        let project_key = workspace::project_hash(&project_path);

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

        let project_key = workspace::project_hash(&project_path);

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

        let project_key = workspace::project_hash(&project_path);

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

        let project_key = workspace::project_hash(&project_path);
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
        let project_key = workspace::project_hash(&project_path);
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

fn ok_json(value: serde_json::Value) -> Result<CallToolResult, McpError> {
    let json = serde_json::to_string_pretty(&value)
        .map_err(|e| McpError::internal_error(e.to_string(), None))?;
    Ok(CallToolResult::success(vec![Content::text(json)]))
}

fn error_json(error: &str, message: impl Into<String>) -> serde_json::Value {
    json!({
        "success": false,
        "error": error,
        "message": message.into(),
    })
}

fn ensure_not_in_grove_task() -> Result<(), McpError> {
    if get_task_context().is_some() {
        return Err(McpError::invalid_request(
            "This tool is only available outside a Grove task",
            None,
        ));
    }
    Ok(())
}

fn add_project_by_path_json(path: &str) -> serde_json::Value {
    let p = std::path::Path::new(path);
    if !p.exists() {
        return error_json("invalid_path", "Path does not exist");
    }

    if !git::is_git_repo(path) {
        return error_json("not_git_repo", "Path is not a Git repository");
    }

    let repo_path = match git::repo_root(path) {
        Ok(v) => v,
        Err(e) => return error_json("not_git_repo", format!("Failed to resolve repo root: {e}")),
    };

    let project_name = std::path::Path::new(&repo_path)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("unknown")
        .to_string();

    let project_id = workspace::project_hash(&repo_path);
    match workspace::is_project_registered(&repo_path) {
        Ok(true) => {
            return json!({
                "success": true,
                "project_id": project_id,
                "path": repo_path,
            })
        }
        Ok(false) => {}
        Err(e) => return error_json("internal_error", format!("Failed to check project: {e}")),
    }

    if let Err(e) = workspace::add_project(&project_name, &repo_path) {
        return error_json("internal_error", format!("Failed to add project: {e}"));
    }

    json!({
        "success": true,
        "project_id": project_id,
        "path": repo_path,
    })
}

fn list_projects_json(query: Option<&str>) -> serde_json::Value {
    match workspace::load_projects() {
        Ok(projects) => {
            let q = query.map(|s| s.trim().to_lowercase());
            let items: Vec<serde_json::Value> = projects
                .into_iter()
                .filter(|p| {
                    if let Some(ref q) = q {
                        if q.is_empty() {
                            return true;
                        }
                        p.path.to_lowercase().contains(q)
                    } else {
                        true
                    }
                })
                .map(|p| {
                    json!({
                        "project_id": workspace::project_hash(&p.path),
                        "path": p.path,
                    })
                })
                .collect();
            json!({
                "success": true,
                "projects": items,
            })
        }
        Err(e) => error_json("internal_error", format!("Failed to load projects: {e}")),
    }
}

fn load_project_by_id(project_id: &str) -> Result<Option<workspace::RegisteredProject>, String> {
    match workspace::load_project_by_hash(project_id).map_err(|e| e.to_string())? {
        Some(p) if std::path::Path::new(&p.path).exists() => Ok(Some(p)),
        _ => Ok(None),
    }
}

fn create_task_json(params: &CreateTaskParams) -> serde_json::Value {
    let project = match load_project_by_id(&params.project_id) {
        Ok(Some(p)) => p,
        Ok(None) => return error_json("project_not_found", "Project not found"),
        Err(e) => return error_json("internal_error", format!("Failed to load project: {e}")),
    };

    let target = git::current_branch(&project.path).unwrap_or_else(|_| "main".to_string());

    let full_config = config::load_config();
    let autolink_patterns = &full_config.auto_link.patterns;

    match operations::tasks::create_task(
        &project.path,
        &params.project_id,
        params.name.clone(),
        target.clone(),
        &full_config.default_session_type(),
        autolink_patterns,
    ) {
        Ok(result) => json!({
            "success": true,
            "task": {
                "task_id": result.task.id,
                "name": result.task.name,
                "branch": result.task.branch,
                "target": result.task.target,
                "worktree_path": result.worktree_path,
            }
        }),
        Err(e) => error_json("task_create_failed", format!("Failed to create task: {e}")),
    }
}

fn list_tasks_json(project_id: &str, query: Option<&str>) -> serde_json::Value {
    match load_project_by_id(project_id) {
        Ok(Some(_project)) => {}
        Ok(None) => return error_json("project_not_found", "Project not found"),
        Err(e) => return error_json("internal_error", format!("Failed to load project: {e}")),
    }

    match tasks::load_tasks(project_id) {
        Ok(list) => {
            let q = query.map(|s| s.trim().to_lowercase());
            let items: Vec<serde_json::Value> = list
                .into_iter()
                .filter(|t| {
                    if let Some(ref q) = q {
                        if q.is_empty() {
                            return true;
                        }
                        t.id.to_lowercase().contains(q)
                            || t.name.to_lowercase().contains(q)
                            || t.branch.to_lowercase().contains(q)
                            || t.target.to_lowercase().contains(q)
                    } else {
                        true
                    }
                })
                .map(|t| {
                    json!({
                        "task_id": t.id,
                        "name": t.name,
                        "branch": t.branch,
                        "target": t.target,
                        "worktree_path": t.worktree_path,
                    })
                })
                .collect();
            json!({
                "success": true,
                "tasks": items,
            })
        }
        Err(e) => error_json("internal_error", format!("Failed to load tasks: {e}")),
    }
}

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

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::{Path, PathBuf};
    use std::process::Command;
    use std::sync::OnceLock;
    use tokio::sync::Mutex;

    static TEST_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

    fn unique_temp_dir(prefix: &str) -> PathBuf {
        let mut p = std::env::temp_dir();
        let pid = std::process::id();
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        p.push(format!("{}-{}-{}", prefix, pid, nanos));
        p
    }

    fn git(repo: &Path, args: &[&str]) {
        let status = Command::new("git")
            .args(args)
            .current_dir(repo)
            .status()
            .expect("failed to run git");
        assert!(status.success(), "git command failed: {:?}", args);
    }

    fn init_git_repo(repo: &Path) {
        std::fs::create_dir_all(repo).unwrap();
        git(repo, &["init"]);
        git(repo, &["config", "user.email", "test@example.com"]);
        git(repo, &["config", "user.name", "Test"]);
        std::fs::write(repo.join("README.md"), "test").unwrap();
        git(repo, &["add", "."]);
        git(repo, &["commit", "-m", "init"]);
    }

    fn with_isolated_home<T>(f: impl FnOnce(&Path) -> T) -> T {
        let _guard = TEST_LOCK.get_or_init(|| Mutex::new(())).blocking_lock();

        let temp_home = unique_temp_dir("grove-mcp-home");
        std::fs::create_dir_all(&temp_home).unwrap();

        let old_home = std::env::var("HOME").ok();
        std::env::set_var("HOME", &temp_home);

        let out = f(&temp_home);

        if let Some(v) = old_home {
            std::env::set_var("HOME", v);
        } else {
            std::env::remove_var("HOME");
        }

        let _ = std::fs::remove_dir_all(&temp_home);
        out
    }

    #[test]
    fn add_project_invalid_path_returns_success_false() {
        with_isolated_home(|home| {
            let missing = home.join("does-not-exist");
            let v = add_project_by_path_json(missing.to_string_lossy().as_ref());
            assert_eq!(v["success"].as_bool(), Some(false));
            assert_eq!(v["error"].as_str(), Some("invalid_path"));
        })
    }

    #[test]
    fn add_project_is_idempotent_and_project_id_resolves() {
        with_isolated_home(|home| {
            let repo = home.join("repo");
            init_git_repo(&repo);

            let v1 = add_project_by_path_json(repo.to_string_lossy().as_ref());
            assert_eq!(v1["success"].as_bool(), Some(true));
            let project_id = v1["project_id"].as_str().unwrap().to_string();
            let repo_path = v1["path"].as_str().unwrap().to_string();

            let v2 = add_project_by_path_json(repo.to_string_lossy().as_ref());
            assert_eq!(v2["success"].as_bool(), Some(true));
            assert_eq!(v2["project_id"].as_str(), Some(project_id.as_str()));

            let p = load_project_by_id(&project_id)
                .expect("project should resolve")
                .expect("project should resolve");
            assert_eq!(p.path, repo_path);
        })
    }

    #[test]
    fn list_projects_contains_registered_project() {
        with_isolated_home(|home| {
            let repo = home.join("repo");
            init_git_repo(&repo);

            let v = add_project_by_path_json(repo.to_string_lossy().as_ref());
            let project_id = v["project_id"].as_str().unwrap().to_string();

            let list = list_projects_json(None);
            assert_eq!(list["success"].as_bool(), Some(true));
            let projects = list["projects"].as_array().unwrap();
            assert!(projects
                .iter()
                .any(|p| p["project_id"].as_str() == Some(&project_id)));
        })
    }

    #[test]
    fn add_project_non_git_repo_returns_success_false() {
        with_isolated_home(|home| {
            let dir = home.join("not-a-repo");
            std::fs::create_dir_all(&dir).unwrap();

            let v = add_project_by_path_json(dir.to_string_lossy().as_ref());
            assert_eq!(v["success"].as_bool(), Some(false));
            assert_eq!(v["error"].as_str(), Some("not_git_repo"));
        })
    }

    #[test]
    fn create_task_unknown_project_returns_success_false() {
        with_isolated_home(|_home| {
            let v = create_task_json(&CreateTaskParams {
                project_id: "deadbeef".to_string(),
                name: "task".to_string(),
            });
            assert_eq!(v["success"].as_bool(), Some(false));
            assert_eq!(v["error"].as_str(), Some("project_not_found"));
        })
    }

    #[test]
    fn create_task_and_list_tasks_only_returns_active() {
        with_isolated_home(|home| {
            let repo = home.join("repo");
            init_git_repo(&repo);

            let add = add_project_by_path_json(repo.to_string_lossy().as_ref());
            let project_id = add["project_id"].as_str().unwrap().to_string();

            let created = create_task_json(&CreateTaskParams {
                project_id: project_id.clone(),
                name: "MCP Task".to_string(),
            });
            assert_eq!(created["success"].as_bool(), Some(true));
            let task_id = created["task"]["task_id"].as_str().unwrap().to_string();
            let worktree_path = created["task"]["worktree_path"]
                .as_str()
                .unwrap()
                .to_string();
            assert!(std::path::Path::new(&worktree_path).exists());

            let list = list_tasks_json(&project_id, None);
            assert_eq!(list["success"].as_bool(), Some(true));
            let tasks_arr = list["tasks"].as_array().unwrap();
            assert!(tasks_arr
                .iter()
                .any(|t| t["task_id"].as_str() == Some(task_id.as_str())));

            // Archive task and ensure list_tasks_json doesn't include it (active only)
            tasks::archive_task(&project_id, &task_id).unwrap();
            let list2 = list_tasks_json(&project_id, None);
            assert_eq!(list2["success"].as_bool(), Some(true));
            let tasks_arr2 = list2["tasks"].as_array().unwrap();
            assert!(!tasks_arr2
                .iter()
                .any(|t| t["task_id"].as_str() == Some(task_id.as_str())));
        })
    }

    #[test]
    fn filter_tools_outside_task_scoped_returns_complement() {
        let _guard = TEST_LOCK.get_or_init(|| Mutex::new(())).blocking_lock();

        let old_task_id = std::env::var("GROVE_TASK_ID").ok();
        let old_project = std::env::var("GROVE_PROJECT").ok();
        std::env::remove_var("GROVE_TASK_ID");
        std::env::remove_var("GROVE_PROJECT");

        let server = GroveMcpServer::new();
        let tools = filter_tools(server.tool_router.list_all());
        let names: HashSet<String> = tools.into_iter().map(|t| t.name.to_string()).collect();

        for name in [
            "grove_add_project_by_path",
            "grove_list_projects",
            "grove_create_task",
            "grove_list_tasks",
        ] {
            assert!(names.contains(name));
        }
        for name in [
            "grove_status",
            "grove_read_notes",
            "grove_read_review",
            "grove_reply_review",
            "grove_add_comment",
            "grove_complete_task",
        ] {
            assert!(!names.contains(name));
        }

        if let Some(v) = old_task_id {
            std::env::set_var("GROVE_TASK_ID", v);
        }
        if let Some(v) = old_project {
            std::env::set_var("GROVE_PROJECT", v);
        }
    }

    #[test]
    fn filter_tools_inside_task_scoped_returns_only_task_scoped() {
        let _guard = TEST_LOCK.get_or_init(|| Mutex::new(())).blocking_lock();

        let old_task_id = std::env::var("GROVE_TASK_ID").ok();
        let old_project = std::env::var("GROVE_PROJECT").ok();
        std::env::set_var("GROVE_TASK_ID", "task-1");
        std::env::set_var("GROVE_PROJECT", "/tmp/repo");

        let server = GroveMcpServer::new();
        let tools = filter_tools(server.tool_router.list_all());
        let names: HashSet<String> = tools.into_iter().map(|t| t.name.to_string()).collect();

        for name in [
            "grove_status",
            "grove_read_notes",
            "grove_read_review",
            "grove_reply_review",
            "grove_add_comment",
            "grove_complete_task",
        ] {
            assert!(names.contains(name));
        }
        for name in [
            "grove_add_project_by_path",
            "grove_list_projects",
            "grove_create_task",
            "grove_list_tasks",
        ] {
            assert!(!names.contains(name));
        }

        if let Some(v) = old_task_id {
            std::env::set_var("GROVE_TASK_ID", v);
        } else {
            std::env::remove_var("GROVE_TASK_ID");
        }
        if let Some(v) = old_project {
            std::env::set_var("GROVE_PROJECT", v);
        } else {
            std::env::remove_var("GROVE_PROJECT");
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn mcp_newline_protocol_smoke_test() {
        use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

        // Ensure tests that mutate HOME don't run concurrently.
        let _guard = TEST_LOCK.get_or_init(|| Mutex::new(())).lock().await;

        let temp_home = unique_temp_dir("grove-mcp-home");
        std::fs::create_dir_all(&temp_home).unwrap();

        let old_home = std::env::var("HOME").ok();
        std::env::set_var("HOME", &temp_home);

        let repo = temp_home.join("repo");
        init_git_repo(&repo);

        let (client_stream, server_stream) = tokio::io::duplex(64 * 1024);
        let (server_read, server_write) = tokio::io::split(server_stream);

        let server_task = tokio::spawn(async move {
            let server = GroveMcpServer::new();
            let service = server
                .serve((server_read, server_write))
                .await
                .map_err(|e| e.to_string())?;
            service.waiting().await.map_err(|e| e.to_string())?;
            Ok::<(), String>(())
        });

        let (client_read, mut client_write) = tokio::io::split(client_stream);
        let mut reader = BufReader::new(client_read);

        async fn send(w: &mut (impl AsyncWriteExt + Unpin), v: serde_json::Value) {
            let mut s = serde_json::to_string(&v).unwrap();
            s.push('\n');
            w.write_all(s.as_bytes()).await.unwrap();
            w.flush().await.unwrap();
        }

        async fn recv_for_id(
            reader: &mut BufReader<tokio::io::ReadHalf<tokio::io::DuplexStream>>,
            id: i64,
        ) -> serde_json::Value {
            loop {
                let mut line = String::new();
                let n = reader.read_line(&mut line).await.unwrap();
                assert!(n > 0, "server closed connection");
                let v: serde_json::Value = serde_json::from_str(line.trim()).unwrap();
                if v.get("id").and_then(|x| x.as_i64()) == Some(id) {
                    return v;
                }
            }
        }

        // initialize
        send(
            &mut client_write,
            json!({
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize",
                "params": {
                    "protocolVersion": "2025-03-26",
                    "capabilities": {},
                    "clientInfo": {"name": "grove-test", "version": "0"}
                }
            }),
        )
        .await;
        let init_resp = recv_for_id(&mut reader, 1).await;
        assert!(init_resp.get("result").is_some());

        // notifications/initialized
        send(
            &mut client_write,
            json!({"jsonrpc": "2.0", "method": "notifications/initialized"}),
        )
        .await;

        // tools/call: grove_add_project_by_path
        send(
            &mut client_write,
            json!({
                "jsonrpc": "2.0",
                "id": 2,
                "method": "tools/call",
                "params": {
                    "name": "grove_add_project_by_path",
                    "arguments": {"path": repo.to_string_lossy()}
                }
            }),
        )
        .await;
        let add_resp = recv_for_id(&mut reader, 2).await;
        let add_text = add_resp["result"]["content"][0]["text"].as_str().unwrap();
        let add_json: serde_json::Value = serde_json::from_str(add_text).unwrap();
        assert_eq!(add_json["success"].as_bool(), Some(true));
        let project_id = add_json["project_id"].as_str().unwrap().to_string();

        // tools/call: grove_create_task
        send(
            &mut client_write,
            json!({
                "jsonrpc": "2.0",
                "id": 3,
                "method": "tools/call",
                "params": {
                    "name": "grove_create_task",
                    "arguments": {"project_id": project_id, "name": "mcp smoke task"}
                }
            }),
        )
        .await;
        let create_resp = recv_for_id(&mut reader, 3).await;
        let create_text = create_resp["result"]["content"][0]["text"]
            .as_str()
            .unwrap();
        let create_json: serde_json::Value = serde_json::from_str(create_text).unwrap();
        assert_eq!(create_json["success"].as_bool(), Some(true));
        assert!(create_json["task"]["task_id"].as_str().is_some());

        // Close client; server should exit.
        client_write.shutdown().await.unwrap();
        drop(client_write);
        drop(reader);
        tokio::time::timeout(std::time::Duration::from_secs(3), server_task)
            .await
            .expect("server did not exit")
            .expect("server task join failed")
            .expect("server returned error");

        if let Some(v) = old_home {
            std::env::set_var("HOME", v);
        } else {
            std::env::remove_var("HOME");
        }
        let _ = std::fs::remove_dir_all(&temp_home);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn mcp_management_tools_rejected_inside_task_context() {
        use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

        let _guard = TEST_LOCK.get_or_init(|| Mutex::new(())).lock().await;

        let temp_home = unique_temp_dir("grove-mcp-home");
        std::fs::create_dir_all(&temp_home).unwrap();

        let old_home = std::env::var("HOME").ok();
        std::env::set_var("HOME", &temp_home);

        let repo = temp_home.join("repo");
        init_git_repo(&repo);

        let old_task_id = std::env::var("GROVE_TASK_ID").ok();
        let old_project = std::env::var("GROVE_PROJECT").ok();
        std::env::set_var("GROVE_TASK_ID", "task-1");
        std::env::set_var("GROVE_PROJECT", repo.to_string_lossy().as_ref());

        let (client_stream, server_stream) = tokio::io::duplex(64 * 1024);
        let (server_read, server_write) = tokio::io::split(server_stream);

        let server_task = tokio::spawn(async move {
            let server = GroveMcpServer::new();
            let service = server
                .serve((server_read, server_write))
                .await
                .map_err(|e| e.to_string())?;
            service.waiting().await.map_err(|e| e.to_string())?;
            Ok::<(), String>(())
        });

        let (client_read, mut client_write) = tokio::io::split(client_stream);
        let mut reader = BufReader::new(client_read);

        async fn send(w: &mut (impl AsyncWriteExt + Unpin), v: serde_json::Value) {
            let mut s = serde_json::to_string(&v).unwrap();
            s.push('\n');
            w.write_all(s.as_bytes()).await.unwrap();
            w.flush().await.unwrap();
        }

        async fn recv_for_id(
            reader: &mut BufReader<tokio::io::ReadHalf<tokio::io::DuplexStream>>,
            id: i64,
        ) -> serde_json::Value {
            loop {
                let mut line = String::new();
                let n = reader.read_line(&mut line).await.unwrap();
                assert!(n > 0, "server closed connection");
                let v: serde_json::Value = serde_json::from_str(line.trim()).unwrap();
                if v.get("id").and_then(|x| x.as_i64()) == Some(id) {
                    return v;
                }
            }
        }

        fn assert_tool_rejected(resp: &serde_json::Value) {
            assert!(
                resp.get("error").is_some(),
                "expected error, got: {}",
                serde_json::to_string(resp).unwrap()
            );
            let err_json = serde_json::to_string(&resp["error"]).unwrap();
            assert!(
                err_json.contains("only available outside a Grove task"),
                "unexpected error: {err_json}"
            );
        }

        send(
            &mut client_write,
            json!({
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize",
                "params": {
                    "protocolVersion": "2025-03-26",
                    "capabilities": {},
                    "clientInfo": {"name": "grove-test", "version": "0"}
                }
            }),
        )
        .await;
        let init_resp = recv_for_id(&mut reader, 1).await;
        assert!(init_resp.get("result").is_some());

        send(
            &mut client_write,
            json!({"jsonrpc": "2.0", "method": "notifications/initialized"}),
        )
        .await;

        send(
            &mut client_write,
            json!({
                "jsonrpc": "2.0",
                "id": 2,
                "method": "tools/call",
                "params": {
                    "name": "grove_add_project_by_path",
                    "arguments": {"path": repo.to_string_lossy()}
                }
            }),
        )
        .await;
        let resp_2 = recv_for_id(&mut reader, 2).await;
        assert_tool_rejected(&resp_2);

        send(
            &mut client_write,
            json!({
                "jsonrpc": "2.0",
                "id": 3,
                "method": "tools/call",
                "params": {"name": "grove_list_projects", "arguments": {}}
            }),
        )
        .await;
        let resp_3 = recv_for_id(&mut reader, 3).await;
        assert_tool_rejected(&resp_3);

        send(
            &mut client_write,
            json!({
                "jsonrpc": "2.0",
                "id": 4,
                "method": "tools/call",
                "params": {
                    "name": "grove_create_task",
                    "arguments": {"project_id": "deadbeef", "name": "task"}
                }
            }),
        )
        .await;
        let resp_4 = recv_for_id(&mut reader, 4).await;
        assert_tool_rejected(&resp_4);

        send(
            &mut client_write,
            json!({
                "jsonrpc": "2.0",
                "id": 5,
                "method": "tools/call",
                "params": {
                    "name": "grove_list_tasks",
                    "arguments": {"project_id": "deadbeef"}
                }
            }),
        )
        .await;
        let resp_5 = recv_for_id(&mut reader, 5).await;
        assert_tool_rejected(&resp_5);

        client_write.shutdown().await.unwrap();
        drop(client_write);
        drop(reader);
        tokio::time::timeout(std::time::Duration::from_secs(3), server_task)
            .await
            .expect("server did not exit")
            .expect("server task join failed")
            .expect("server returned error");

        if let Some(v) = old_task_id {
            std::env::set_var("GROVE_TASK_ID", v);
        } else {
            std::env::remove_var("GROVE_TASK_ID");
        }
        if let Some(v) = old_project {
            std::env::set_var("GROVE_PROJECT", v);
        } else {
            std::env::remove_var("GROVE_PROJECT");
        }
        if let Some(v) = old_home {
            std::env::set_var("HOME", v);
        } else {
            std::env::remove_var("HOME");
        }
        let _ = std::fs::remove_dir_all(&temp_home);
    }
}

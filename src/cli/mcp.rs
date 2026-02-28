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

use crate::acp;
use crate::git;
use crate::operations;
use crate::storage::{chat_history, comments, config, notes, tasks, workspace};

// ============================================================================
// Grove Instructions for AI
// ============================================================================

const MANAGEMENT_INSTRUCTIONS: &str = r#"
# Grove - Parallel Task Orchestration

Grove lets you break down work into isolated, parallel tasks under a project.
Each task provides an independent working directory where work can proceed
without affecting other tasks or the main codebase.

## Available Tools

### Task Management
1. **grove_list_projects** — Find a registered project
2. **grove_add_project_by_path** — Register a project (idempotent)
3. **grove_create_task** — Spawn an isolated subtask for parallel work
4. **grove_list_tasks** — Query existing active tasks
5. **grove_edit_note** — Write task notes (spec, context, instructions)

### Agent Chat Control
6. **grove_list_agents** — List available worker agents
7. **grove_start_chat** — Create and start a chat session (returns chat_id)
8. **grove_chat_status** — Get chat state, auto-connects if needed, returns available modes/models
9. **grove_send_prompt** — Send prompt / respond to permission / cancel turn
10. **grove_list_chats** — List chat sessions for a task

## Orchestration Workflow
1. Find or register the target project
2. Call `grove_list_agents` to see available worker agents
3. Call `grove_create_task` for each subtask
4. Call `grove_edit_note` to write task spec and context
5. Call `grove_start_chat` to launch a worker agent
6. Call `grove_chat_status` to wait for agent ready and get available modes/models
7. Call `grove_send_prompt` to instruct the worker (always call `grove_chat_status` first!)
8. Poll with `grove_chat_status` until idle
   - If `permission_needed`: use `grove_send_prompt` with `permission_option_id`
   - If stuck: use `grove_send_prompt` with `cancel: true`
9. Review results in `last_message` / `plan`, send follow-ups as needed

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

/// Edit notes for a task (workspace-scoped, for orchestrator agents)
#[derive(Debug, Serialize, Deserialize, JsonSchema)]
pub struct EditNoteParams {
    /// Project ID (hash)
    pub project_id: String,
    /// Task ID
    pub task_id: String,
    /// New note content (markdown). Replaces entire note. Pass empty string to clear.
    pub content: String,
}

/// Start a chat session for a task (management tool)
#[derive(Debug, Serialize, Deserialize, JsonSchema)]
pub struct StartChatParams {
    /// Project ID (hash)
    pub project_id: String,
    /// Task ID
    pub task_id: String,
    /// Chat name (default: "New Chat {timestamp}")
    pub name: Option<String>,
    /// Agent to use (default: config default). Use grove_list_agents to see available agents.
    pub agent: Option<String>,
}

/// Send a prompt, respond to permission, or cancel a chat turn (management tool).
///
/// Exactly one of `text`, `permission_option_id`, or `cancel` must be provided:
/// - `text` → send a prompt (optionally switch mode/model first)
/// - `permission_option_id` → respond to a pending permission request
/// - `cancel: true` → cancel the current agent turn
#[derive(Debug, Serialize, Deserialize, JsonSchema)]
pub struct SendPromptParams {
    /// Project ID (hash)
    pub project_id: String,
    /// Task ID
    pub task_id: String,
    /// Chat ID
    pub chat_id: String,
    /// Prompt text to send. Mutually exclusive with permission_option_id and cancel.
    pub text: Option<String>,
    /// Switch agent mode before sending prompt (e.g., "plan", "code"). Only used with text.
    pub mode_id: Option<String>,
    /// Switch agent model before sending prompt (e.g., "opus", "sonnet"). Only used with text.
    pub model_id: Option<String>,
    /// Respond to a pending permission request with this option ID. Mutually exclusive with text and cancel.
    pub permission_option_id: Option<String>,
    /// Set to true to cancel the current agent turn. Mutually exclusive with text and permission_option_id.
    #[serde(default)]
    pub cancel: bool,
    /// Sender name (e.g., "Claude Code (Orchestrator)"). Shown in chat UI to identify who sent the message.
    pub sender: Option<String>,
}

/// Query chat status (management tool)
#[derive(Debug, Serialize, Deserialize, JsonSchema)]
pub struct ChatStatusParams {
    /// Project ID (hash)
    pub project_id: String,
    /// Task ID
    pub task_id: String,
    /// Chat ID
    pub chat_id: String,
}

/// List chats for a task (management tool)
#[derive(Debug, Serialize, Deserialize, JsonSchema)]
pub struct ListChatsParams {
    /// Project ID (hash)
    pub project_id: String,
    /// Task ID
    pub task_id: String,
    /// Optional fuzzy query for filtering by chat name
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
        description = "Register a Git project by its local filesystem path. Idempotent — safe to call repeatedly."
    )]
    async fn grove_add_project_by_path(
        &self,
        params: Parameters<AddProjectByPathParams>,
    ) -> Result<CallToolResult, McpError> {
        ensure_not_in_grove_task()?;
        let path = params.0.path;
        blocking_json(move || add_project_by_path_json(&path)).await
    }

    /// List all registered projects
    #[tool(
        name = "grove_list_projects",
        description = "List registered projects. Use `query` to fuzzy-filter by path."
    )]
    async fn grove_list_projects(
        &self,
        params: Parameters<ListProjectsParams>,
    ) -> Result<CallToolResult, McpError> {
        ensure_not_in_grove_task()?;
        let query = params.0.query;
        blocking_json(move || list_projects_json(query.as_deref())).await
    }

    /// Create a task/worktree under a project (does NOT start tmux/zellij session)
    #[tool(
        name = "grove_create_task",
        description = "Create an isolated subtask under a project. Tasks run in parallel without interfering with each other."
    )]
    async fn grove_create_task(
        &self,
        params: Parameters<CreateTaskParams>,
    ) -> Result<CallToolResult, McpError> {
        ensure_not_in_grove_task()?;
        let p = params.0;
        blocking_json(move || create_task_json(&p)).await
    }

    /// List active tasks under a project
    #[tool(
        name = "grove_list_tasks",
        description = "List active tasks under a project. Use `query` to fuzzy-filter by name or branch."
    )]
    async fn grove_list_tasks(
        &self,
        params: Parameters<ListTasksParams>,
    ) -> Result<CallToolResult, McpError> {
        ensure_not_in_grove_task()?;
        let project_id = params.0.project_id;
        let query = params.0.query;
        blocking_json(move || list_tasks_json(&project_id, query.as_deref())).await
    }

    /// Write or update notes for a task (management tool for orchestrator agents)
    #[tool(
        name = "grove_edit_note",
        description = "Write or update notes for a task. Used to set task spec, context, and instructions before the task agent starts working."
    )]
    async fn grove_edit_note(
        &self,
        params: Parameters<EditNoteParams>,
    ) -> Result<CallToolResult, McpError> {
        ensure_not_in_grove_task()?;
        let p = params.0;
        blocking_json(move || edit_note_json(&p)).await
    }

    /// List available agents
    #[tool(
        name = "grove_list_agents",
        description = "List available agents that can be used to start chat sessions. Returns built-in and custom agents with their capabilities."
    )]
    async fn grove_list_agents(&self) -> Result<CallToolResult, McpError> {
        ensure_not_in_grove_task()?;
        blocking_json(list_agents_json).await
    }

    /// Start a new chat session for a task
    #[tool(
        name = "grove_start_chat",
        description = "Create and start a chat session for a task. Spawns the agent process. Returns chat_id, name, and agent. After calling this, use grove_chat_status to wait for the agent to be ready and get available modes/models."
    )]
    async fn grove_start_chat(
        &self,
        params: Parameters<StartChatParams>,
    ) -> Result<CallToolResult, McpError> {
        ensure_not_in_grove_task()?;
        let p = params.0;
        start_chat_impl(p).await
    }

    /// Send a prompt, respond to permission, or cancel a chat turn
    #[tool(
        name = "grove_send_prompt",
        description = "Interact with a chat session. Three mutually exclusive actions: (1) `text` — send a prompt (optionally set mode_id/model_id). (2) `permission_option_id` — respond to a pending permission request. (3) `cancel: true` — cancel the current turn. Returns immediately. IMPORTANT: Always call grove_chat_status first to check the session state and available modes/models before sending."
    )]
    async fn grove_send_prompt(
        &self,
        params: Parameters<SendPromptParams>,
    ) -> Result<CallToolResult, McpError> {
        ensure_not_in_grove_task()?;
        let p = params.0;
        send_prompt_impl(p).await
    }

    /// Query chat status (auto-connects the session if not running)
    #[tool(
        name = "grove_chat_status",
        description = "Get the current state of a chat session. Auto-connects the agent if not already running. Returns: state (idle/busy/permission_needed), available_modes, available_models, turn_count, last_message, plan, and permission details. Always call this before grove_send_prompt to know the session state and what modes/models are available."
    )]
    async fn grove_chat_status(
        &self,
        params: Parameters<ChatStatusParams>,
    ) -> Result<CallToolResult, McpError> {
        ensure_not_in_grove_task()?;
        let p = params.0;
        chat_status_impl(p).await
    }

    /// List chats for a task
    #[tool(
        name = "grove_list_chats",
        description = "List all chat sessions under a task. Returns id, title, agent, and creation time for each chat."
    )]
    async fn grove_list_chats(
        &self,
        params: Parameters<ListChatsParams>,
    ) -> Result<CallToolResult, McpError> {
        ensure_not_in_grove_task()?;
        let p = params.0;
        list_chats_impl(p).await
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
        validate_task_exists(&project_key, &task_id)?;

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
        validate_task_exists(&project_key, &task_id)?;
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

async fn blocking_json(
    f: impl FnOnce() -> serde_json::Value + Send + 'static,
) -> Result<CallToolResult, McpError> {
    let value = tokio::task::spawn_blocking(f)
        .await
        .map_err(|e| McpError::internal_error(e.to_string(), None))?;
    ok_json(value)
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

/// Validate that the project is registered and the task exists in storage.
/// Catches misconfigured GROVE_PROJECT / GROVE_TASK_ID env vars before
/// any data is written to disk.
fn validate_task_exists(project_key: &str, task_id: &str) -> Result<(), McpError> {
    match workspace::load_project_by_hash(project_key) {
        Ok(Some(_)) => {}
        Ok(None) => {
            return Err(McpError::invalid_request(
                "Project not found. GROVE_PROJECT may be misconfigured.",
                None,
            ));
        }
        Err(e) => {
            return Err(McpError::internal_error(
                format!("Failed to verify project: {}", e),
                None,
            ));
        }
    }

    match tasks::get_task(project_key, task_id) {
        Ok(Some(_)) => Ok(()),
        Ok(None) => Err(McpError::invalid_request(
            "Task not found. GROVE_TASK_ID may be misconfigured.",
            None,
        )),
        Err(e) => Err(McpError::internal_error(
            format!("Failed to verify task: {}", e),
            None,
        )),
    }
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

/// Fuzzy match: checks if `query` matches `haystack` with flexible matching.
///
/// Strategy (all case-insensitive):
///
/// 1. Split query into whitespace-separated tokens
/// 2. Each token must match via at least one of:
///   - Substring match (e.g., "auth" in "authentication")
///   - Word-prefix match — split haystack on separators and check if any
///     word starts with the token (e.g., "lg" matches "login")
///   - Initials match — token characters match the first letters of
///     consecutive words (e.g., "al" matches "auth-login")
fn fuzzy_matches(haystack: &str, query: &str) -> bool {
    let h = haystack.to_lowercase();
    let q = query.trim().to_lowercase();
    if q.is_empty() {
        return true;
    }

    // Split haystack into "words" on common separators
    let words: Vec<&str> = h
        .split(['/', '-', '_', '.', ' '])
        .filter(|w| !w.is_empty())
        .collect();

    q.split_whitespace().all(|token| {
        // (a) Substring match
        if h.contains(token) {
            return true;
        }
        // (b) Any word starts with token
        if words.iter().any(|w| w.starts_with(token)) {
            return true;
        }
        // (c) Initials match: each char of token matches the start of a consecutive word
        if token.len() >= 2 && token.len() <= words.len() {
            let token_chars: Vec<char> = token.chars().collect();
            // Sliding window over words
            'outer: for start in 0..=words.len() - token_chars.len() {
                for (i, &tc) in token_chars.iter().enumerate() {
                    if !words[start + i].starts_with(tc) {
                        continue 'outer;
                    }
                }
                return true;
            }
        }
        false
    })
}

fn list_projects_json(query: Option<&str>) -> serde_json::Value {
    match workspace::load_projects() {
        Ok(projects) => {
            let items: Vec<serde_json::Value> = projects
                .into_iter()
                .filter(|p| match query {
                    Some(q) => fuzzy_matches(&p.path, q) || fuzzy_matches(&p.name, q),
                    None => true,
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
        "agent",
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
            let items: Vec<serde_json::Value> = list
                .into_iter()
                .filter(|t| match query {
                    Some(q) => {
                        fuzzy_matches(&t.id, q)
                            || fuzzy_matches(&t.name, q)
                            || fuzzy_matches(&t.branch, q)
                            || fuzzy_matches(&t.target, q)
                    }
                    None => true,
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

fn edit_note_json(params: &EditNoteParams) -> serde_json::Value {
    match load_project_by_id(&params.project_id) {
        Ok(Some(_)) => {}
        Ok(None) => return error_json("project_not_found", "Project not found"),
        Err(e) => return error_json("internal_error", format!("Failed to load project: {e}")),
    }

    match tasks::get_task(&params.project_id, &params.task_id) {
        Ok(Some(_)) => {}
        Ok(None) => return error_json("task_not_found", "Task not found"),
        Err(e) => return error_json("internal_error", format!("Failed to verify task: {e}")),
    }

    if let Err(e) = notes::save_notes(&params.project_id, &params.task_id, &params.content) {
        return error_json("save_failed", format!("Failed to save notes: {e}"));
    }

    json!({
        "success": true,
        "task_id": params.task_id,
        "content_length": params.content.len(),
    })
}

// ============================================================================
// ACP Chat Management Helpers (async — used by management MCP tools)
// ============================================================================

/// Built-in agent definitions (id, name)
const BUILTIN_AGENTS: &[(&str, &str)] = &[
    ("claude", "Claude Code"),
    ("codex", "Codex"),
    ("traecli", "Trae CLI"),
    ("kimi", "Kimi"),
    ("gemini", "Gemini CLI"),
    ("qwen", "Qwen"),
    ("opencode", "OpenCode"),
    ("copilot", "GitHub Copilot"),
];

fn list_agents_json() -> serde_json::Value {
    let cfg = config::load_config();
    let default_agent = cfg
        .acp
        .agent_command
        .clone()
        .unwrap_or_else(|| "claude".to_string());

    let mut agents: Vec<serde_json::Value> = BUILTIN_AGENTS
        .iter()
        .map(|(id, name)| {
            json!({
                "id": id,
                "name": name,
                "type": "builtin",
                "agent_type": "local",
            })
        })
        .collect();

    for custom in &cfg.acp.custom_agents {
        agents.push(json!({
            "id": custom.id,
            "name": custom.name,
            "type": "custom",
            "agent_type": custom.agent_type,
        }));
    }

    json!({
        "default_agent": default_agent,
        "agents": agents,
    })
}

/// Resolve project → (project_key, project_path, project_name) with MCP error handling
fn resolve_project_for_mcp(project_id: &str) -> Result<(String, String, String), McpError> {
    let project = match load_project_by_id(project_id) {
        Ok(Some(p)) => p,
        Ok(None) => return Err(McpError::invalid_params("Project not found", None)),
        Err(e) => {
            return Err(McpError::internal_error(
                format!("Failed to load project: {e}"),
                None,
            ))
        }
    };
    let project_key = workspace::project_hash(&project.path);
    Ok((project_key, project.path, project.name))
}

/// Resolve task with MCP error handling
fn resolve_task_for_mcp(project_key: &str, task_id: &str) -> Result<tasks::Task, McpError> {
    match tasks::get_task(project_key, task_id) {
        Ok(Some(t)) => Ok(t),
        Ok(None) => Err(McpError::invalid_params("Task not found", None)),
        Err(e) => Err(McpError::internal_error(
            format!("Failed to load task: {e}"),
            None,
        )),
    }
}

/// Build session key for ACP
fn build_session_key(project_key: &str, task_id: &str, chat_id: &str) -> String {
    format!("{}:{}:{}", project_key, task_id, chat_id)
}

/// Build GROVE_* env vars for ACP agent
fn build_grove_env(
    project_key: &str,
    project_path: &str,
    project_name: &str,
    task: &tasks::Task,
) -> std::collections::HashMap<String, String> {
    let mut env = std::collections::HashMap::new();
    env.insert("GROVE_TASK_ID".into(), task.id.clone());
    env.insert("GROVE_TASK_NAME".into(), task.name.clone());
    env.insert("GROVE_BRANCH".into(), task.branch.clone());
    env.insert("GROVE_TARGET".into(), task.target.clone());
    env.insert("GROVE_WORKTREE".into(), task.worktree_path.clone());
    env.insert("GROVE_PROJECT_NAME".into(), project_name.into());
    env.insert("GROVE_PROJECT".into(), project_path.into());
    env.insert("GROVE_PROJECT_KEY".into(), project_key.into());
    env
}

async fn start_chat_impl(p: StartChatParams) -> Result<CallToolResult, McpError> {
    let (project_key, project_path, project_name) = resolve_project_for_mcp(&p.project_id)?;
    let task = resolve_task_for_mcp(&project_key, &p.task_id)?;

    let cfg = config::load_config();
    let agent_name = p.agent.unwrap_or_else(|| {
        cfg.acp
            .agent_command
            .clone()
            .unwrap_or_else(|| "claude".to_string())
    });

    // Resolve agent
    let resolved = acp::resolve_agent(&agent_name)
        .ok_or_else(|| McpError::invalid_params(format!("Unknown agent: {}", agent_name), None))?;

    // Create chat session in storage
    let now = chrono::Utc::now();
    let title = p
        .name
        .unwrap_or_else(|| format!("New Chat {}", now.format("%Y-%m-%d %H:%M")));
    let chat_id = tasks::generate_chat_id();

    let chat = tasks::ChatSession {
        id: chat_id.clone(),
        title: title.clone(),
        agent: agent_name.clone(),
        acp_session_id: None,
        created_at: now,
    };

    tasks::add_chat_session(&project_key, &p.task_id, chat)
        .map_err(|e| McpError::internal_error(format!("Failed to save chat: {e}"), None))?;

    // Build ACP start config
    let env_vars = build_grove_env(&project_key, &project_path, &project_name, &task);
    let session_key = build_session_key(&project_key, &p.task_id, &chat_id);
    let working_dir = std::path::PathBuf::from(&task.worktree_path);

    let acp_config = acp::AcpStartConfig {
        agent_command: resolved.command,
        agent_args: resolved.args,
        working_dir,
        env_vars,
        project_key: project_key.clone(),
        task_id: p.task_id.clone(),
        chat_id: Some(chat_id.clone()),
        agent_type: resolved.agent_type,
        remote_url: resolved.url,
        remote_auth: resolved.auth_header,
    };

    // Start session (non-blocking — caller should use grove_chat_status to wait for ready)
    let (_handle, _rx) = acp::get_or_start_session(session_key, acp_config)
        .await
        .map_err(|e| McpError::internal_error(format!("Failed to start ACP session: {e}"), None))?;

    ok_json(json!({
        "chat_id": chat_id,
        "name": title,
        "agent": agent_name,
    }))
}

/// Get an existing session handle, or auto-start one if the chat exists in storage.
/// Resolve session access: discover existing (local or remote), or auto-start a new one.
async fn resolve_session_access(
    project_key: &str,
    project_path: &str,
    project_name: &str,
    task: &tasks::Task,
    chat_id: &str,
) -> Result<acp::SessionAccess, McpError> {
    let session_key = build_session_key(project_key, &task.id, chat_id);

    // Try discover (in-process HashMap → socket probe)
    if let Some(access) = acp::discover_session(project_key, &task.id, chat_id, &session_key) {
        return Ok(access);
    }

    // Not found anywhere — look up chat in storage and auto-start
    let chat = tasks::get_chat_session(project_key, &task.id, chat_id)
        .map_err(|e| McpError::internal_error(format!("Failed to load chat: {e}"), None))?
        .ok_or_else(|| McpError::invalid_params("Chat not found", None))?;

    let resolved = acp::resolve_agent(&chat.agent)
        .ok_or_else(|| McpError::internal_error(format!("Unknown agent: {}", chat.agent), None))?;

    let env_vars = build_grove_env(project_key, project_path, project_name, task);
    let working_dir = std::path::PathBuf::from(&task.worktree_path);

    let config = acp::AcpStartConfig {
        agent_command: resolved.command,
        agent_args: resolved.args,
        working_dir,
        env_vars,
        project_key: project_key.to_string(),
        task_id: task.id.clone(),
        chat_id: Some(chat_id.to_string()),
        agent_type: resolved.agent_type,
        remote_url: resolved.url,
        remote_auth: resolved.auth_header,
    };

    // Start session — may race with another process. If bind() fails (AddrInUse),
    // the socket listener inside get_or_start_session will log and skip, which is fine.
    // A subsequent discover_session would find the remote.
    let (handle, _rx) = acp::get_or_start_session(session_key, config)
        .await
        .map_err(|e| McpError::internal_error(format!("Failed to start ACP session: {e}"), None))?;

    Ok(acp::SessionAccess::Local(handle))
}

async fn send_prompt_impl(p: SendPromptParams) -> Result<CallToolResult, McpError> {
    // Validate mutual exclusivity
    let action_count =
        p.text.is_some() as u8 + p.permission_option_id.is_some() as u8 + p.cancel as u8;
    if action_count == 0 {
        return Err(McpError::invalid_params(
            "Exactly one of `text`, `permission_option_id`, or `cancel` must be provided",
            None,
        ));
    }
    if action_count > 1 {
        return Err(McpError::invalid_params(
            "`text`, `permission_option_id`, and `cancel` are mutually exclusive",
            None,
        ));
    }

    let (project_key, project_path, project_name) = resolve_project_for_mcp(&p.project_id)?;
    let task = resolve_task_for_mcp(&project_key, &p.task_id)?;

    let access = resolve_session_access(
        &project_key,
        &project_path,
        &project_name,
        &task,
        &p.chat_id,
    )
    .await?;

    match access {
        acp::SessionAccess::Local(handle) => send_prompt_local(&handle, p).await,
        acp::SessionAccess::Remote { sock_path, .. } => send_prompt_remote(&sock_path, p).await,
    }
}

/// Send prompt via local in-process handle
async fn send_prompt_local(
    handle: &acp::AcpSessionHandle,
    p: SendPromptParams,
) -> Result<CallToolResult, McpError> {
    // Action: cancel
    if p.cancel {
        handle
            .cancel()
            .await
            .map_err(|e| McpError::internal_error(format!("Failed to cancel: {e}"), None))?;
        return ok_json(json!({ "action": "cancelled" }));
    }

    // Action: respond to permission
    if let Some(option_id) = p.permission_option_id {
        handle.respond_permission(option_id);
        return ok_json(json!({ "action": "permission_responded" }));
    }

    // Action: send prompt
    let text = p.text.unwrap(); // safe: validated above

    // Set mode if requested
    if let Some(mode_id) = p.mode_id {
        handle
            .set_mode(mode_id)
            .await
            .map_err(|e| McpError::internal_error(format!("Failed to set mode: {e}"), None))?;
    }

    // Set model if requested
    if let Some(model_id) = p.model_id {
        handle
            .set_model(model_id)
            .await
            .map_err(|e| McpError::internal_error(format!("Failed to set model: {e}"), None))?;
    }

    handle
        .send_prompt(text, vec![], p.sender)
        .await
        .map_err(|e| McpError::internal_error(format!("Failed to send prompt: {e}"), None))?;

    ok_json(json!({ "action": "prompt_sent" }))
}

/// Send prompt via Unix socket to remote session owner
async fn send_prompt_remote(
    sock_path: &std::path::Path,
    p: SendPromptParams,
) -> Result<CallToolResult, McpError> {
    let cmd = if p.cancel {
        acp::SocketCommand::Cancel
    } else if let Some(option_id) = p.permission_option_id {
        acp::SocketCommand::RespondPermission { option_id }
    } else {
        let text = p.text.unwrap(); // safe: validated above

        // Set mode first if requested
        if let Some(mode_id) = p.mode_id {
            let mode_cmd = acp::SocketCommand::SetMode { mode_id };
            let resp = acp::send_socket_command(sock_path, &mode_cmd)
                .await
                .map_err(|e| {
                    McpError::internal_error(format!("Socket set_mode failed: {e}"), None)
                })?;
            if let acp::SocketResponse::Error { message } = resp {
                return Err(McpError::internal_error(
                    format!("Remote set_mode failed: {}", message),
                    None,
                ));
            }
        }

        // Set model if requested
        if let Some(model_id) = p.model_id {
            let model_cmd = acp::SocketCommand::SetModel { model_id };
            let resp = acp::send_socket_command(sock_path, &model_cmd)
                .await
                .map_err(|e| {
                    McpError::internal_error(format!("Socket set_model failed: {e}"), None)
                })?;
            if let acp::SocketResponse::Error { message } = resp {
                return Err(McpError::internal_error(
                    format!("Remote set_model failed: {}", message),
                    None,
                ));
            }
        }

        acp::SocketCommand::Prompt {
            text,
            attachments: vec![],
            sender: p.sender,
        }
    };

    let action_name = match &cmd {
        acp::SocketCommand::Cancel => "cancelled",
        acp::SocketCommand::RespondPermission { .. } => "permission_responded",
        _ => "prompt_sent",
    };

    let resp = acp::send_socket_command(sock_path, &cmd)
        .await
        .map_err(|e| McpError::internal_error(format!("Socket command failed: {e}"), None))?;

    match resp {
        acp::SocketResponse::Ok => ok_json(json!({ "action": action_name })),
        acp::SocketResponse::Error { message } => Err(McpError::internal_error(
            format!("Remote command failed: {}", message),
            None,
        )),
    }
}

async fn chat_status_impl(p: ChatStatusParams) -> Result<CallToolResult, McpError> {
    let (project_key, project_path, project_name) = resolve_project_for_mcp(&p.project_id)?;
    let task = resolve_task_for_mcp(&project_key, &p.task_id)?;

    // Auto-connect: resolve session (local, remote, or start new)
    let access = resolve_session_access(
        &project_key,
        &project_path,
        &project_name,
        &task,
        &p.chat_id,
    )
    .await?;

    match access {
        acp::SessionAccess::Local(handle) => chat_status_from_handle(&handle).await,
        acp::SessionAccess::Remote {
            project_key,
            task_id,
            chat_id,
            ..
        } => chat_status_from_disk(&project_key, &task_id, &chat_id).await,
    }
}

/// Build chat status from local in-process handle
async fn chat_status_from_handle(
    handle: &acp::AcpSessionHandle,
) -> Result<CallToolResult, McpError> {
    // Wait briefly for SessionReady if the session was just started
    let timeout = tokio::time::Duration::from_secs(60);
    let modes_models = tokio::time::timeout(timeout, async {
        loop {
            let history = handle.get_history();
            for event in &history {
                if let acp::AcpUpdate::SessionReady {
                    available_modes,
                    available_models,
                    ..
                } = event
                {
                    return (available_modes.clone(), available_models.clone());
                }
            }
            tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;
        }
    })
    .await
    .map_err(|_| McpError::internal_error("Timeout waiting for agent to initialize (60s)", None))?;

    let (available_modes, available_models) = modes_models;

    let history = handle.get_history();
    let compacted = chat_history::compact_events(history);

    build_chat_status_json(&compacted, &available_modes, &available_models)
}

/// Build chat status from disk (for remote sessions owned by another process)
async fn chat_status_from_disk(
    project_key: &str,
    task_id: &str,
    chat_id: &str,
) -> Result<CallToolResult, McpError> {
    // Poll session.json for modes/models (may not be written yet if agent just started)
    let timeout = tokio::time::Duration::from_secs(60);
    let metadata = tokio::time::timeout(timeout, async {
        loop {
            if let Some(meta) = acp::read_session_metadata(project_key, task_id, chat_id) {
                return meta;
            }
            tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;
        }
    })
    .await
    .map_err(|_| {
        McpError::internal_error("Timeout waiting for remote session metadata (60s)", None)
    })?;

    // Load history from disk and compact
    let history = chat_history::load_history(project_key, task_id, chat_id);
    let compacted = chat_history::compact_events(history);

    build_chat_status_json(
        &compacted,
        &metadata.available_modes,
        &metadata.available_models,
    )
}

/// Build the chat status JSON response from compacted events and mode/model info
fn build_chat_status_json(
    compacted: &[acp::AcpUpdate],
    available_modes: &[(String, String)],
    available_models: &[(String, String)],
) -> Result<CallToolResult, McpError> {
    let last_message = extract_last_message(compacted);
    let plan = extract_last_plan(compacted);
    let turn_count = compacted
        .iter()
        .filter(|e| matches!(e, acp::AcpUpdate::Complete { .. }))
        .count();
    let permission = extract_pending_permission(compacted);

    let state = if permission.is_some() {
        "permission_needed"
    } else {
        let last_significant = compacted.iter().rev().find(|e| {
            matches!(
                e,
                acp::AcpUpdate::Complete { .. }
                    | acp::AcpUpdate::UserMessage { .. }
                    | acp::AcpUpdate::MessageChunk { .. }
                    | acp::AcpUpdate::ToolCall { .. }
                    | acp::AcpUpdate::ThoughtChunk { .. }
            )
        });

        match last_significant {
            Some(acp::AcpUpdate::Complete { .. }) => "idle",
            Some(_) => "busy",
            None => "idle",
        }
    };

    let mut result = json!({
        "state": state,
        "turn_count": turn_count,
        "last_message": last_message,
        "available_modes": available_modes.iter().map(|(id, name)| json!({"id": id, "name": name})).collect::<Vec<_>>(),
        "available_models": available_models.iter().map(|(id, name)| json!({"id": id, "name": name})).collect::<Vec<_>>(),
    });

    if let Some(plan_entries) = plan {
        result["plan"] = plan_entries;
    }

    if let Some(perm) = permission {
        result["permission"] = perm;
    }

    if let Some(plan_file) = extract_last_plan_file(compacted) {
        result["plan_file"] = json!(plan_file);
    }

    ok_json(result)
}

/// Extract the last plan file path from events
fn extract_last_plan_file(events: &[acp::AcpUpdate]) -> Option<String> {
    events.iter().rev().find_map(|e| match e {
        acp::AcpUpdate::PlanFileUpdate { path } => Some(path.clone()),
        _ => None,
    })
}

async fn list_chats_impl(p: ListChatsParams) -> Result<CallToolResult, McpError> {
    let (project_key, _, _) = resolve_project_for_mcp(&p.project_id)?;
    let _ = resolve_task_for_mcp(&project_key, &p.task_id)?;

    let chats = tasks::load_chat_sessions(&project_key, &p.task_id)
        .map_err(|e| McpError::internal_error(format!("Failed to load chats: {e}"), None))?;

    let items: Vec<serde_json::Value> = chats
        .iter()
        .filter(|c| match &p.query {
            Some(q) => fuzzy_matches(&c.title, q) || fuzzy_matches(&c.agent, q),
            None => true,
        })
        .map(|c| {
            json!({
                "id": c.id,
                "title": c.title,
                "agent": c.agent,
                "created_at": c.created_at.to_rfc3339(),
            })
        })
        .collect();

    ok_json(json!({ "chats": items }))
}

/// Extract the last assistant message from compacted history.
/// Finds all MessageChunk events after the last Complete, or the last MessageChunk before
/// the most recent Complete if the agent is idle.
fn extract_last_message(events: &[acp::AcpUpdate]) -> Option<String> {
    // Find the position of the last Complete
    let last_complete_pos = events
        .iter()
        .rposition(|e| matches!(e, acp::AcpUpdate::Complete { .. }));

    // If there's a Complete, get the MessageChunk right before it (after previous Complete/start)
    if let Some(complete_pos) = last_complete_pos {
        // Find the previous Complete (or start of events)
        let prev_complete_pos = events[..complete_pos]
            .iter()
            .rposition(|e| matches!(e, acp::AcpUpdate::Complete { .. }))
            .map(|p| p + 1)
            .unwrap_or(0);

        // Collect all MessageChunk text in this turn
        let text: String = events[prev_complete_pos..complete_pos]
            .iter()
            .filter_map(|e| match e {
                acp::AcpUpdate::MessageChunk { text } => Some(text.as_str()),
                _ => None,
            })
            .collect();

        if !text.is_empty() {
            return Some(text);
        }
    }

    // Also check for MessageChunk after last Complete (agent currently working)
    let start = last_complete_pos.map(|p| p + 1).unwrap_or(0);
    let text: String = events[start..]
        .iter()
        .filter_map(|e| match e {
            acp::AcpUpdate::MessageChunk { text } => Some(text.as_str()),
            _ => None,
        })
        .collect();

    if !text.is_empty() {
        Some(text)
    } else {
        None
    }
}

/// Extract the last PlanUpdate entries from history
fn extract_last_plan(events: &[acp::AcpUpdate]) -> Option<serde_json::Value> {
    events.iter().rev().find_map(|e| match e {
        acp::AcpUpdate::PlanUpdate { entries } => Some(json!(entries
            .iter()
            .map(|entry| json!({
                "content": entry.content,
                "status": entry.status,
            }))
            .collect::<Vec<_>>())),
        _ => None,
    })
}

/// Extract pending permission request (last PermissionRequest without a matching PermissionResponse)
fn extract_pending_permission(events: &[acp::AcpUpdate]) -> Option<serde_json::Value> {
    // Walk backwards to find the last PermissionRequest
    let mut last_perm_req = None;
    let mut last_perm_resp_pos = None;
    let mut last_perm_req_pos = None;

    for (i, e) in events.iter().enumerate().rev() {
        match e {
            acp::AcpUpdate::PermissionResponse { .. } if last_perm_resp_pos.is_none() => {
                last_perm_resp_pos = Some(i);
            }
            acp::AcpUpdate::PermissionRequest {
                description,
                options,
            } if last_perm_req.is_none() => {
                last_perm_req = Some((description.clone(), options.clone()));
                last_perm_req_pos = Some(i);
            }
            _ => {}
        }
        if last_perm_req.is_some() {
            break;
        }
    }

    // Only return if PermissionRequest comes after PermissionResponse (or no response exists)
    if let (Some((desc, opts)), Some(req_pos)) = (last_perm_req, last_perm_req_pos) {
        let is_resolved = last_perm_resp_pos.is_some_and(|resp_pos| resp_pos > req_pos);
        if !is_resolved {
            return Some(json!({
                "description": desc,
                "options": opts.iter().map(|o| json!({
                    "option_id": o.option_id,
                    "name": o.name,
                    "kind": o.kind,
                })).collect::<Vec<_>>(),
            }));
        }
    }

    None
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
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    use tokio::sync::Mutex;

    static TEST_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

    // ---- EnvGuard: RAII env-var restore (panic-safe) ----

    struct EnvGuard {
        saved: Vec<(String, Option<String>)>,
    }

    impl EnvGuard {
        fn new() -> Self {
            Self { saved: Vec::new() }
        }

        fn set(&mut self, key: &str, value: &str) {
            if !self.saved.iter().any(|(k, _)| k == key) {
                self.saved.push((key.to_string(), std::env::var(key).ok()));
            }
            std::env::set_var(key, value);
        }

        fn remove(&mut self, key: &str) {
            if !self.saved.iter().any(|(k, _)| k == key) {
                self.saved.push((key.to_string(), std::env::var(key).ok()));
            }
            std::env::remove_var(key);
        }
    }

    impl Drop for EnvGuard {
        fn drop(&mut self) {
            for (key, value) in &self.saved {
                match value {
                    Some(v) => std::env::set_var(key, v),
                    None => std::env::remove_var(key),
                }
            }
        }
    }

    // ---- McpTestClient: MCP protocol test harness ----

    struct McpTestClient {
        writer: tokio::io::WriteHalf<tokio::io::DuplexStream>,
        reader: BufReader<tokio::io::ReadHalf<tokio::io::DuplexStream>>,
        server_task: tokio::task::JoinHandle<Result<(), String>>,
    }

    impl McpTestClient {
        async fn start() -> Self {
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

            let (client_read, writer) = tokio::io::split(client_stream);
            let reader = BufReader::new(client_read);

            Self {
                writer,
                reader,
                server_task,
            }
        }

        async fn send(&mut self, v: serde_json::Value) {
            let mut s = serde_json::to_string(&v).unwrap();
            s.push('\n');
            self.writer.write_all(s.as_bytes()).await.unwrap();
            self.writer.flush().await.unwrap();
        }

        async fn recv_for_id(&mut self, id: i64) -> serde_json::Value {
            loop {
                let mut line = String::new();
                let n = self.reader.read_line(&mut line).await.unwrap();
                assert!(n > 0, "server closed connection");
                let v: serde_json::Value = serde_json::from_str(line.trim()).unwrap();
                if v.get("id").and_then(|x| x.as_i64()) == Some(id) {
                    return v;
                }
            }
        }

        async fn handshake(&mut self) {
            self.send(json!({
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize",
                "params": {
                    "protocolVersion": "2025-03-26",
                    "capabilities": {},
                    "clientInfo": {"name": "grove-test", "version": "0"}
                }
            }))
            .await;
            let init_resp = self.recv_for_id(1).await;
            assert!(init_resp.get("result").is_some());

            self.send(json!({"jsonrpc": "2.0", "method": "notifications/initialized"}))
                .await;
        }

        async fn call_tool(
            &mut self,
            id: i64,
            name: &str,
            args: serde_json::Value,
        ) -> serde_json::Value {
            self.send(json!({
                "jsonrpc": "2.0",
                "id": id,
                "method": "tools/call",
                "params": {"name": name, "arguments": args}
            }))
            .await;
            self.recv_for_id(id).await
        }

        async fn shutdown(self) {
            let Self {
                mut writer,
                reader,
                server_task,
            } = self;
            writer.shutdown().await.unwrap();
            drop(writer);
            drop(reader);
            tokio::time::timeout(std::time::Duration::from_secs(3), server_task)
                .await
                .expect("server did not exit")
                .expect("server task join failed")
                .expect("server returned error");
        }
    }

    // ---- Test helpers ----

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

    /// Remove git env vars that leak from pre-commit hooks into test subprocesses.
    fn clear_git_env(env: &mut EnvGuard) {
        for key in &[
            "GIT_DIR",
            "GIT_WORK_TREE",
            "GIT_INDEX_FILE",
            "GIT_OBJECT_DIRECTORY",
            "GIT_ALTERNATE_OBJECT_DIRECTORIES",
        ] {
            env.remove(key);
        }
    }

    fn with_isolated_home<T>(f: impl FnOnce(&Path) -> T) -> T {
        let _guard = TEST_LOCK.get_or_init(|| Mutex::new(())).blocking_lock();

        let temp_home = unique_temp_dir("grove-mcp-home");
        std::fs::create_dir_all(&temp_home).unwrap();

        let mut env = EnvGuard::new();
        env.set("HOME", temp_home.to_string_lossy().as_ref());
        clear_git_env(&mut env);

        let out = f(&temp_home);

        drop(env);
        let _ = std::fs::remove_dir_all(&temp_home);
        out
    }

    // ---- Sync tests ----

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
    fn list_projects_query_filters_correctly() {
        with_isolated_home(|home| {
            let repo_alpha = home.join("alpha-project");
            init_git_repo(&repo_alpha);
            let repo_beta = home.join("beta-service");
            init_git_repo(&repo_beta);

            add_project_by_path_json(repo_alpha.to_string_lossy().as_ref());
            add_project_by_path_json(repo_beta.to_string_lossy().as_ref());

            // No filter → both projects
            let all = list_projects_json(None);
            assert_eq!(all["projects"].as_array().unwrap().len(), 2);

            // Filter "alpha" → only alpha
            let filtered = list_projects_json(Some("alpha"));
            let projects = filtered["projects"].as_array().unwrap();
            assert_eq!(projects.len(), 1);
            assert!(projects[0]["path"].as_str().unwrap().contains("alpha"));

            // Case-insensitive: "BETA" → only beta
            let filtered = list_projects_json(Some("BETA"));
            let projects = filtered["projects"].as_array().unwrap();
            assert_eq!(projects.len(), 1);
            assert!(projects[0]["path"].as_str().unwrap().contains("beta"));

            // No match → empty
            let filtered = list_projects_json(Some("nonexistent"));
            assert_eq!(filtered["projects"].as_array().unwrap().len(), 0);
        })
    }

    #[test]
    fn list_tasks_returns_error_for_unknown_project() {
        with_isolated_home(|_home| {
            let v = list_tasks_json("nonexistent-hash", None);
            assert_eq!(v["success"].as_bool(), Some(false));
            assert_eq!(v["error"].as_str(), Some("project_not_found"));
        })
    }

    #[test]
    fn list_tasks_query_filters_by_name() {
        with_isolated_home(|home| {
            let repo = home.join("repo");
            init_git_repo(&repo);

            let add = add_project_by_path_json(repo.to_string_lossy().as_ref());
            let project_id = add["project_id"].as_str().unwrap().to_string();

            create_task_json(&CreateTaskParams {
                project_id: project_id.clone(),
                name: "Auth Login".to_string(),
            });
            create_task_json(&CreateTaskParams {
                project_id: project_id.clone(),
                name: "Dashboard UI".to_string(),
            });

            // No filter → both tasks
            let all = list_tasks_json(&project_id, None);
            assert_eq!(all["tasks"].as_array().unwrap().len(), 2);

            // Filter "dashboard" → only dashboard task
            let filtered = list_tasks_json(&project_id, Some("dashboard"));
            let tasks = filtered["tasks"].as_array().unwrap();
            assert_eq!(tasks.len(), 1);
            assert_eq!(tasks[0]["name"].as_str(), Some("Dashboard UI"));

            // Case-insensitive: "AUTH" → only auth task
            let filtered = list_tasks_json(&project_id, Some("AUTH"));
            let tasks = filtered["tasks"].as_array().unwrap();
            assert_eq!(tasks.len(), 1);
            assert_eq!(tasks[0]["name"].as_str(), Some("Auth Login"));

            // No match → empty
            let filtered = list_tasks_json(&project_id, Some("nonexistent"));
            assert_eq!(filtered["tasks"].as_array().unwrap().len(), 0);
        })
    }

    #[test]
    fn add_project_from_subdirectory_resolves_to_root() {
        with_isolated_home(|home| {
            let repo = home.join("my-repo");
            init_git_repo(&repo);

            let subdir = repo.join("src").join("lib");
            std::fs::create_dir_all(&subdir).unwrap();

            // Register via subdirectory path
            let v = add_project_by_path_json(subdir.to_string_lossy().as_ref());
            assert_eq!(v["success"].as_bool(), Some(true));

            // Returned path should be repo root, not subdirectory
            let returned_path = v["path"].as_str().unwrap();
            assert!(
                !returned_path.ends_with("src/lib"),
                "expected repo root, got subdirectory: {}",
                returned_path
            );

            // Register via root path → same project_id (idempotent)
            let v2 = add_project_by_path_json(repo.to_string_lossy().as_ref());
            assert_eq!(v2["project_id"].as_str(), v["project_id"].as_str());
        })
    }

    #[test]
    fn filter_tools_outside_task_scoped_returns_complement() {
        let _guard = TEST_LOCK.get_or_init(|| Mutex::new(())).blocking_lock();

        let mut env = EnvGuard::new();
        env.remove("GROVE_TASK_ID");
        env.remove("GROVE_PROJECT");

        let server = GroveMcpServer::new();
        let tools = filter_tools(server.tool_router.list_all());
        let names: HashSet<String> = tools.into_iter().map(|t| t.name.to_string()).collect();

        for name in [
            "grove_add_project_by_path",
            "grove_list_projects",
            "grove_create_task",
            "grove_list_tasks",
            "grove_edit_note",
            "grove_list_agents",
            "grove_start_chat",
            "grove_send_prompt",
            "grove_chat_status",
            "grove_list_chats",
        ] {
            assert!(
                names.contains(name),
                "expected tool '{}' outside task",
                name
            );
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
    }

    #[test]
    fn filter_tools_inside_task_scoped_returns_only_task_scoped() {
        let _guard = TEST_LOCK.get_or_init(|| Mutex::new(())).blocking_lock();

        let mut env = EnvGuard::new();
        env.set("GROVE_TASK_ID", "task-1");
        env.set("GROVE_PROJECT", "/tmp/repo");

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
            "grove_edit_note",
            "grove_list_agents",
            "grove_start_chat",
            "grove_send_prompt",
            "grove_chat_status",
            "grove_list_chats",
        ] {
            assert!(!names.contains(name));
        }
    }

    #[test]
    fn get_instructions_switches_on_task_context() {
        let _guard = TEST_LOCK.get_or_init(|| Mutex::new(())).blocking_lock();

        // Outside task → management instructions
        {
            let mut env = EnvGuard::new();
            env.remove("GROVE_TASK_ID");
            env.remove("GROVE_PROJECT");
            let instr = get_instructions();
            assert!(
                instr.contains("Parallel Task Orchestration"),
                "expected management instructions outside task"
            );
        }

        // Inside task → execution instructions
        {
            let mut env = EnvGuard::new();
            env.set("GROVE_TASK_ID", "task-1");
            env.set("GROVE_PROJECT", "/tmp/repo");
            let instr = get_instructions();
            assert!(
                instr.contains("Git Worktree Task Manager"),
                "expected execution instructions inside task"
            );
        }
    }

    // ---- Async integration tests ----

    #[tokio::test(flavor = "current_thread")]
    async fn mcp_newline_protocol_smoke_test() {
        let _guard = TEST_LOCK.get_or_init(|| Mutex::new(())).lock().await;

        let temp_home = unique_temp_dir("grove-mcp-home");
        std::fs::create_dir_all(&temp_home).unwrap();

        let mut env = EnvGuard::new();
        env.set("HOME", temp_home.to_string_lossy().as_ref());
        clear_git_env(&mut env);

        let repo = temp_home.join("repo");
        init_git_repo(&repo);

        let mut client = McpTestClient::start().await;
        client.handshake().await;

        let add_resp = client
            .call_tool(
                2,
                "grove_add_project_by_path",
                json!({"path": repo.to_string_lossy()}),
            )
            .await;
        let add_text = add_resp["result"]["content"][0]["text"].as_str().unwrap();
        let add_json: serde_json::Value = serde_json::from_str(add_text).unwrap();
        assert_eq!(add_json["success"].as_bool(), Some(true));
        let project_id = add_json["project_id"].as_str().unwrap().to_string();

        let create_resp = client
            .call_tool(
                3,
                "grove_create_task",
                json!({"project_id": project_id, "name": "mcp smoke task"}),
            )
            .await;
        let create_text = create_resp["result"]["content"][0]["text"]
            .as_str()
            .unwrap();
        let create_json: serde_json::Value = serde_json::from_str(create_text).unwrap();
        assert_eq!(create_json["success"].as_bool(), Some(true));
        assert!(create_json["task"]["task_id"].as_str().is_some());

        client.shutdown().await;
        drop(env);
        let _ = std::fs::remove_dir_all(&temp_home);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn mcp_management_tools_rejected_inside_task_context() {
        let _guard = TEST_LOCK.get_or_init(|| Mutex::new(())).lock().await;

        let temp_home = unique_temp_dir("grove-mcp-home");
        std::fs::create_dir_all(&temp_home).unwrap();

        let mut env = EnvGuard::new();
        env.set("HOME", temp_home.to_string_lossy().as_ref());
        clear_git_env(&mut env);

        let repo = temp_home.join("repo");
        init_git_repo(&repo);

        env.set("GROVE_TASK_ID", "task-1");
        env.set("GROVE_PROJECT", repo.to_string_lossy().as_ref());

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

        let mut client = McpTestClient::start().await;
        client.handshake().await;

        let resp_2 = client
            .call_tool(
                2,
                "grove_add_project_by_path",
                json!({"path": repo.to_string_lossy()}),
            )
            .await;
        assert_tool_rejected(&resp_2);

        let resp_3 = client.call_tool(3, "grove_list_projects", json!({})).await;
        assert_tool_rejected(&resp_3);

        let resp_4 = client
            .call_tool(
                4,
                "grove_create_task",
                json!({"project_id": "deadbeef", "name": "task"}),
            )
            .await;
        assert_tool_rejected(&resp_4);

        let resp_5 = client
            .call_tool(5, "grove_list_tasks", json!({"project_id": "deadbeef"}))
            .await;
        assert_tool_rejected(&resp_5);

        let resp_6 = client
            .call_tool(
                6,
                "grove_edit_note",
                json!({"project_id": "deadbeef", "task_id": "t1", "content": "hello"}),
            )
            .await;
        assert_tool_rejected(&resp_6);

        // New ACP management tools should also be rejected inside task context
        let resp_7 = client.call_tool(7, "grove_list_agents", json!({})).await;
        assert_tool_rejected(&resp_7);

        let resp_8 = client
            .call_tool(
                8,
                "grove_start_chat",
                json!({"project_id": "x", "task_id": "y"}),
            )
            .await;
        assert_tool_rejected(&resp_8);

        let resp_9 = client
            .call_tool(
                9,
                "grove_send_prompt",
                json!({"project_id": "x", "task_id": "y", "chat_id": "z", "text": "hi"}),
            )
            .await;
        assert_tool_rejected(&resp_9);

        let resp_10 = client
            .call_tool(
                10,
                "grove_chat_status",
                json!({"project_id": "x", "task_id": "y", "chat_id": "z"}),
            )
            .await;
        assert_tool_rejected(&resp_10);

        let resp_11 = client
            .call_tool(
                11,
                "grove_list_chats",
                json!({"project_id": "x", "task_id": "y"}),
            )
            .await;
        assert_tool_rejected(&resp_11);

        client.shutdown().await;
        drop(env);
        let _ = std::fs::remove_dir_all(&temp_home);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn mcp_grove_status_returns_full_context() {
        let _guard = TEST_LOCK.get_or_init(|| Mutex::new(())).lock().await;

        let temp_home = unique_temp_dir("grove-mcp-home");
        std::fs::create_dir_all(&temp_home).unwrap();

        let mut env = EnvGuard::new();
        env.set("HOME", temp_home.to_string_lossy().as_ref());
        clear_git_env(&mut env);

        let repo = temp_home.join("repo");
        init_git_repo(&repo);

        env.set("GROVE_TASK_ID", "my-task");
        env.set("GROVE_PROJECT", repo.to_string_lossy().as_ref());
        env.set("GROVE_TASK_NAME", "My Task");
        env.set("GROVE_BRANCH", "feature/my-task");
        env.set("GROVE_TARGET", "main");
        env.set("GROVE_PROJECT_NAME", "test-project");

        let mut client = McpTestClient::start().await;
        client.handshake().await;

        // grove_status should return all task context fields
        let resp = client.call_tool(2, "grove_status", json!({})).await;
        let text = resp["result"]["content"][0]["text"].as_str().unwrap();
        let status: serde_json::Value = serde_json::from_str(text).unwrap();

        assert_eq!(status["in_grove_task"].as_bool(), Some(true));
        assert_eq!(status["task_id"].as_str(), Some("my-task"));
        assert_eq!(status["task_name"].as_str(), Some("My Task"));
        assert_eq!(status["branch"].as_str(), Some("feature/my-task"));
        assert_eq!(status["target"].as_str(), Some("main"));
        assert_eq!(status["project"].as_str(), Some("test-project"));

        client.shutdown().await;
        drop(env);
        let _ = std::fs::remove_dir_all(&temp_home);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn mcp_execution_tools_roundtrip() {
        let _guard = TEST_LOCK.get_or_init(|| Mutex::new(())).lock().await;

        let temp_home = unique_temp_dir("grove-mcp-home");
        std::fs::create_dir_all(&temp_home).unwrap();

        let mut env = EnvGuard::new();
        env.set("HOME", temp_home.to_string_lossy().as_ref());
        clear_git_env(&mut env);

        let repo = temp_home.join("repo");
        init_git_repo(&repo);

        // Register project — use the canonical path returned by git
        let add = add_project_by_path_json(repo.to_string_lossy().as_ref());
        assert_eq!(add["success"].as_bool(), Some(true));
        let project_id = add["project_id"].as_str().unwrap().to_string();
        let canonical_repo = add["path"].as_str().unwrap().to_string();
        let project_key = workspace::project_hash(&canonical_repo);

        let created = create_task_json(&CreateTaskParams {
            project_id,
            name: "Roundtrip Task".to_string(),
        });
        assert_eq!(created["success"].as_bool(), Some(true));
        let task_id = created["task"]["task_id"].as_str().unwrap().to_string();

        env.set("GROVE_TASK_ID", &task_id);
        env.set("GROVE_PROJECT", &canonical_repo);

        let mut client = McpTestClient::start().await;
        client.handshake().await;

        // --- grove_read_notes: no notes exist → friendly message ---
        let resp = client.call_tool(2, "grove_read_notes", json!({})).await;
        let text = resp["result"]["content"][0]["text"].as_str().unwrap();
        assert_eq!(text, "No notes yet.");

        // --- grove_read_notes: save notes, then read back ---
        notes::save_notes(&project_key, &task_id, "Remember to add tests").unwrap();
        let resp = client.call_tool(3, "grove_read_notes", json!({})).await;
        let text = resp["result"]["content"][0]["text"].as_str().unwrap();
        assert_eq!(text, "Remember to add tests");

        // --- grove_add_comment: project-level → success ---
        let resp = client
            .call_tool(
                4,
                "grove_add_comment",
                json!({
                    "comments": [{"comment_type": "project", "content": "Needs more tests"}]
                }),
            )
            .await;
        let text = resp["result"]["content"][0]["text"].as_str().unwrap();
        let add_result: serde_json::Value = serde_json::from_str(text).unwrap();
        assert_eq!(add_result["created"].as_array().unwrap().len(), 1);
        let comment_id = add_result["created"][0]["comment_id"].as_u64().unwrap();
        assert_eq!(add_result["created"][0]["type"].as_str(), Some("project"));

        // --- grove_add_comment: inline missing file_path → error ---
        let resp = client
            .call_tool(
                5,
                "grove_add_comment",
                json!({
                    "comments": [{"comment_type": "inline", "content": "fix this", "start_line": 1}]
                }),
            )
            .await;
        assert!(
            resp.get("error").is_some(),
            "expected error for inline comment without file_path, got: {}",
            serde_json::to_string(&resp).unwrap()
        );

        // --- grove_read_review: returns the created comment ---
        let resp = client.call_tool(6, "grove_read_review", json!({})).await;
        let text = resp["result"]["content"][0]["text"].as_str().unwrap();
        let review: serde_json::Value = serde_json::from_str(text).unwrap();
        assert_eq!(review["open_count"].as_u64(), Some(1));
        assert_eq!(
            review["comments"][0]["content"].as_str(),
            Some("Needs more tests")
        );
        assert_eq!(review["comments"][0]["type"].as_str(), Some("project"));

        // --- grove_reply_review: reply to existing comment → success ---
        let resp = client
            .call_tool(
                7,
                "grove_reply_review",
                json!({
                    "replies": [{"comment_id": comment_id, "message": "Done, added tests"}]
                }),
            )
            .await;
        let text = resp["result"]["content"][0]["text"].as_str().unwrap();
        let reply_result: serde_json::Value = serde_json::from_str(text).unwrap();
        assert_eq!(reply_result["replies"][0]["success"].as_bool(), Some(true));

        // --- grove_reply_review: empty replies → error ---
        let resp = client
            .call_tool(8, "grove_reply_review", json!({"replies": []}))
            .await;
        assert!(
            resp.get("error").is_some(),
            "expected error for empty replies array"
        );

        // --- grove_reply_review: nonexistent comment → error ---
        let resp = client
            .call_tool(
                9,
                "grove_reply_review",
                json!({"replies": [{"comment_id": 9999, "message": "hello"}]}),
            )
            .await;
        assert!(
            resp.get("error").is_some(),
            "expected error for reply to nonexistent comment"
        );

        client.shutdown().await;
        drop(env);
        let _ = std::fs::remove_dir_all(&temp_home);
    }

    /// Env vars point to a project/task that was never registered or created.
    /// Write operations (add_comment, reply_review) must reject with clear errors.
    /// Read operations (read_notes, read_review) degrade gracefully.
    #[tokio::test(flavor = "current_thread")]
    async fn mcp_execution_tools_with_nonexistent_task() {
        let _guard = TEST_LOCK.get_or_init(|| Mutex::new(())).lock().await;

        let temp_home = unique_temp_dir("grove-mcp-home");
        std::fs::create_dir_all(&temp_home).unwrap();

        let mut env = EnvGuard::new();
        env.set("HOME", temp_home.to_string_lossy().as_ref());
        clear_git_env(&mut env);

        // Point to a directory that exists but was never registered as a project.
        // GROVE_TASK_ID refers to a task that was never created.
        let fake_project = temp_home.join("not-a-project");
        std::fs::create_dir_all(&fake_project).unwrap();
        env.set("GROVE_TASK_ID", "ghost-task");
        env.set("GROVE_PROJECT", fake_project.to_string_lossy().as_ref());

        let mut client = McpTestClient::start().await;
        client.handshake().await;

        fn assert_error_contains(resp: &serde_json::Value, expected: &str) {
            assert!(
                resp.get("error").is_some(),
                "expected error, got: {}",
                serde_json::to_string(resp).unwrap()
            );
            let err_json = serde_json::to_string(&resp["error"]).unwrap();
            assert!(
                err_json.contains(expected),
                "expected error containing '{}', got: {}",
                expected,
                err_json
            );
        }

        // grove_read_notes: no data on disk → graceful message, not a crash
        let resp = client.call_tool(2, "grove_read_notes", json!({})).await;
        let text = resp["result"]["content"][0]["text"].as_str().unwrap();
        assert_eq!(text, "No notes yet.");

        // grove_read_review: no data on disk → graceful message
        let resp = client.call_tool(3, "grove_read_review", json!({})).await;
        let text = resp["result"]["content"][0]["text"].as_str().unwrap();
        assert_eq!(text, "No code review comments yet.");

        // grove_reply_review: project not registered → rejected
        let resp = client
            .call_tool(
                4,
                "grove_reply_review",
                json!({"replies": [{"comment_id": 1, "message": "hi"}]}),
            )
            .await;
        assert_error_contains(&resp, "Project not found");

        // grove_add_comment: project not registered → rejected (no orphan data)
        let resp = client
            .call_tool(
                5,
                "grove_add_comment",
                json!({
                    "comments": [{"comment_type": "project", "content": "orphan comment"}]
                }),
            )
            .await;
        assert_error_contains(&resp, "Project not found");

        // --- Now register project but DON'T create the task ---
        let repo = temp_home.join("real-repo");
        init_git_repo(&repo);
        let add = add_project_by_path_json(repo.to_string_lossy().as_ref());
        let canonical_repo = add["path"].as_str().unwrap().to_string();
        env.set("GROVE_PROJECT", &canonical_repo);
        // GROVE_TASK_ID still points to "ghost-task" which doesn't exist

        // grove_add_comment: project exists but task doesn't → rejected
        let resp = client
            .call_tool(
                6,
                "grove_add_comment",
                json!({
                    "comments": [{"comment_type": "project", "content": "orphan comment"}]
                }),
            )
            .await;
        assert_error_contains(&resp, "Task not found");

        // grove_reply_review: project exists but task doesn't → rejected
        let resp = client
            .call_tool(
                7,
                "grove_reply_review",
                json!({"replies": [{"comment_id": 1, "message": "hi"}]}),
            )
            .await;
        assert_error_contains(&resp, "Task not found");

        client.shutdown().await;
        drop(env);
        let _ = std::fs::remove_dir_all(&temp_home);
    }

    /// grove_edit_note: management tool roundtrip — write notes, read back via worker context.
    #[tokio::test(flavor = "current_thread")]
    async fn mcp_edit_note_roundtrip() {
        let _guard = TEST_LOCK.get_or_init(|| Mutex::new(())).lock().await;

        let temp_home = unique_temp_dir("grove-mcp-home");
        std::fs::create_dir_all(&temp_home).unwrap();

        let mut env = EnvGuard::new();
        env.set("HOME", temp_home.to_string_lossy().as_ref());
        clear_git_env(&mut env);

        let repo = temp_home.join("repo");
        init_git_repo(&repo);

        // --- Management phase: outside task context ---
        env.remove("GROVE_TASK_ID");
        env.remove("GROVE_PROJECT");

        // Register project and create task
        let add = add_project_by_path_json(repo.to_string_lossy().as_ref());
        assert_eq!(add["success"].as_bool(), Some(true));
        let project_id = add["project_id"].as_str().unwrap().to_string();
        let canonical_repo = add["path"].as_str().unwrap().to_string();

        let created = create_task_json(&CreateTaskParams {
            project_id: project_id.clone(),
            name: "Note Test Task".to_string(),
        });
        assert_eq!(created["success"].as_bool(), Some(true));
        let task_id = created["task"]["task_id"].as_str().unwrap().to_string();

        let mut client = McpTestClient::start().await;
        client.handshake().await;

        // edit_note: project not found → error
        let resp = client
            .call_tool(
                2,
                "grove_edit_note",
                json!({"project_id": "nonexistent", "task_id": &task_id, "content": "x"}),
            )
            .await;
        let text = resp["result"]["content"][0]["text"].as_str().unwrap();
        let result: serde_json::Value = serde_json::from_str(text).unwrap();
        assert_eq!(result["success"].as_bool(), Some(false));
        assert_eq!(result["error"].as_str(), Some("project_not_found"));

        // edit_note: task not found → error
        let resp = client
            .call_tool(
                3,
                "grove_edit_note",
                json!({"project_id": &project_id, "task_id": "ghost", "content": "x"}),
            )
            .await;
        let text = resp["result"]["content"][0]["text"].as_str().unwrap();
        let result: serde_json::Value = serde_json::from_str(text).unwrap();
        assert_eq!(result["success"].as_bool(), Some(false));
        assert_eq!(result["error"].as_str(), Some("task_not_found"));

        // edit_note: success
        let resp = client
            .call_tool(
                4,
                "grove_edit_note",
                json!({
                    "project_id": &project_id,
                    "task_id": &task_id,
                    "content": "## Task Spec\nImplement feature X"
                }),
            )
            .await;
        let text = resp["result"]["content"][0]["text"].as_str().unwrap();
        let result: serde_json::Value = serde_json::from_str(text).unwrap();
        assert_eq!(result["success"].as_bool(), Some(true));
        assert_eq!(result["task_id"].as_str(), Some(task_id.as_str()));
        assert_eq!(result["content_length"].as_u64(), Some(32));

        client.shutdown().await;

        // --- Worker phase: switch to task context, read back ---
        env.set("GROVE_TASK_ID", &task_id);
        env.set("GROVE_PROJECT", &canonical_repo);

        let mut client = McpTestClient::start().await;
        client.handshake().await;

        let resp = client.call_tool(2, "grove_read_notes", json!({})).await;
        let text = resp["result"]["content"][0]["text"].as_str().unwrap();
        assert_eq!(text, "## Task Spec\nImplement feature X");

        client.shutdown().await;
        drop(env);
        let _ = std::fs::remove_dir_all(&temp_home);
    }
}

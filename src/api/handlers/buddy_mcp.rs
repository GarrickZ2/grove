//! Buddy's loopback-only MCP transport. Tokens bind to a single active Segment.
use axum::http::request::Parts;
use once_cell::sync::Lazy;
use rmcp::handler::server::{
    tool::{Extension, ToolRouter},
    wrapper::Parameters,
};
use rmcp::schemars::{self, JsonSchema};
use rmcp::transport::streamable_http_server::{
    session::local::LocalSessionManager, StreamableHttpServerConfig, StreamableHttpService,
};
use rmcp::{model::*, tool, tool_router, ErrorData as McpError, ServerHandler};
use serde::Deserialize;
use std::collections::HashMap;
use std::sync::{Arc, RwLock};

static TOKENS: Lazy<RwLock<HashMap<String, String>>> = Lazy::new(RwLock::default);

pub fn register_token(token: &str, session: &str) {
    TOKENS.write().unwrap().insert(token.into(), session.into());
}
pub fn unregister_token(token: &str) {
    TOKENS.write().unwrap().remove(token);
}
pub fn build_mcp_url(token: &str) -> Option<String> {
    Some(format!(
        "http://127.0.0.1:{}/buddy-mcp/{token}",
        super::agent_graph_mcp::listener_port()?
    ))
}

pub(crate) fn caller(parts: &Parts) -> Result<(crate::storage::buddies::Buddy, String), McpError> {
    let token = parts
        .uri
        .path()
        .trim_end_matches('/')
        .strip_prefix("/buddy-mcp/")
        .ok_or_else(|| McpError::invalid_request("Invalid Buddy MCP route", None))?;
    let session = TOKENS
        .read()
        .unwrap()
        .get(token)
        .cloned()
        .ok_or_else(|| McpError::invalid_request("Invalid Buddy token", None))?;
    let conn = crate::storage::database::connection();
    crate::storage::buddies::ensure_session_writable_on(&conn, &session).map_err(internal)?;
    let segment = crate::storage::buddies::get_segment(&conn, &session).map_err(internal)?;
    let buddy_id = match segment {
        Some(segment) => segment.buddy_id,
        None => {
            crate::storage::buddy_groups::member_by_session(&conn, &session)
                .map_err(internal)?
                .ok_or_else(|| McpError::invalid_request("Not a Buddy Segment", None))?
                .buddy_id
        }
    };
    let buddy = crate::storage::buddies::get(&conn, &buddy_id)
        .map_err(internal)?
        .ok_or_else(|| McpError::invalid_request("Buddy not found", None))?;
    Ok((buddy, session))
}
/// A reference the Buddy got wrong; the message says what would work.
fn invalid(error: impl std::fmt::Display) -> McpError {
    McpError::invalid_params(error.to_string(), None)
}

fn internal(error: impl std::fmt::Display) -> McpError {
    McpError::internal_error(error.to_string(), None)
}

#[derive(Clone)]
pub struct BuddyMcpService {
    tool_router: ToolRouter<Self>,
}
impl Default for BuddyMcpService {
    fn default() -> Self {
        Self {
            tool_router: Self::tool_router(),
        }
    }
}
impl ServerHandler for BuddyMcpService {
    fn get_info(&self) -> ServerInfo {
        let mut info = ServerInfo::new(ServerCapabilities::builder().enable_tools().build());
        info.server_info = Implementation::new("grove-buddy", env!("CARGO_PKG_VERSION"));
        info
    }
    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        context: rmcp::service::RequestContext<rmcp::RoleServer>,
    ) -> Result<CallToolResult, McpError> {
        let parts = context
            .extensions
            .get::<Parts>()
            .ok_or_else(|| McpError::invalid_request("Missing Buddy context", None))?;
        let (buddy, session) = caller(parts)?;
        // MCP requests can outlive the Agent turn that issued them. Keep their
        // source Segment admitted until the operation has finished.
        let key = format!("{}:_local:{session}", buddy.project_hash);
        let handle = crate::acp::get_session_handle(&key)
            .ok_or_else(|| McpError::invalid_request("Buddy runtime is no longer active", None))?;
        let _activity = handle.begin_activity().map_err(internal)?;
        if self.tool_router.has_route(&request.name) {
            let call = rmcp::handler::server::tool::ToolCallContext::new(self, request, context);
            self.tool_router.call(call).await
        } else {
            let trusted = crate::storage::tasks::find_chat_session(&session)
                .map_err(internal)?
                .ok_or_else(|| McpError::invalid_request("Missing Buddy Session", None))?;
            super::agent_graph_mcp::call_shared_tool(
                &request.name,
                trusted,
                serde_json::Value::Object(request.arguments.unwrap_or_default()),
            )
            .await
        }
    }
    async fn list_tools(
        &self,
        _: Option<PaginatedRequestParams>,
        context: rmcp::service::RequestContext<rmcp::RoleServer>,
    ) -> Result<ListToolsResult, McpError> {
        let parts = context
            .extensions
            .get::<Parts>()
            .ok_or_else(|| McpError::invalid_request("Missing Buddy context", None))?;
        let (buddy, _) = caller(parts)?;
        let mut tools = self.tool_router.list_all();
        tools.extend(super::agent_graph_mcp::shared_tools(&buddy.project_hash));
        Ok(ListToolsResult {
            tools,
            next_cursor: None,
            meta: None,
        })
    }
}
pub fn streamable_service() -> StreamableHttpService<BuddyMcpService, LocalSessionManager> {
    StreamableHttpService::new(
        || Ok(BuddyMcpService::default()),
        Arc::new(LocalSessionManager::default()),
        StreamableHttpServerConfig::default()
            .with_stateful_mode(true)
            .with_json_response(false),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::{buddies, database};
    #[test]
    fn buddy_tool_surface_excludes_graph_and_title_tools() {
        let names: Vec<_> = BuddyMcpService::tool_router()
            .list_all()
            .into_iter()
            .map(|t| t.name.to_string())
            .collect();
        assert!(names.iter().any(|name| name == "send"));
        assert!(names.iter().all(|name| !name.starts_with("buddy_")));
        // call_tool dispatches by registered name; shared tools must never shadow it.
        let router = BuddyMcpService::tool_router();
        assert!(names.iter().all(|name| router.has_route(name)));
        assert!([
            "memory_recall",
            "memory_append_log",
            "ask_form",
            "speak",
            "browser_open"
        ]
        .iter()
        .all(|name| !router.has_route(name)));
        assert!(!names
            .iter()
            .any(|name| name == "set_title" || name == "grove_complete_task"));
    }

    #[test]
    fn list_results_are_text_because_structured_content_must_be_an_object() {
        let list = success(vec![serde_json::json!({"id":"p"})]).unwrap();
        assert!(list.structured_content.is_none());
        let text = serde_json::to_value(&list.content).unwrap().to_string();
        assert!(text.contains("\\\"id\\\": \\\"p\\\""), "{text}");
        let object = success(serde_json::json!({"deleted":true})).unwrap();
        assert_eq!(
            object.structured_content,
            Some(serde_json::json!({"deleted":true}))
        );
    }

    #[test]
    fn tokens_expire_and_ended_callers_are_rejected() {
        let _lock = database::test_lock().blocking_lock();
        let _store = buddies::test_support::Store::new();
        let buddy = buddies::test_support::seed_buddy(&database::connection(), "token");
        let session = buddy.active_session_id.unwrap();
        let parts = axum::http::Request::builder()
            .uri("/buddy-mcp/test-token/")
            .body(())
            .unwrap()
            .into_parts()
            .0;
        assert!(caller(&parts).is_err());
        register_token("test-token", &session);
        assert_eq!(caller(&parts).unwrap().0.id, buddy.id);
        buddies::end_segment(&database::connection(), &buddy.id, &session, "ended").unwrap();
        assert!(caller(&parts).is_err());
        unregister_token("test-token");
        assert!(!TOKENS.read().unwrap().contains_key("test-token"));
    }
}

/// MCP `structuredContent` must be a JSON object; clients reject arrays and
/// scalars. Lists therefore go out as pretty JSON text, like Agent Graph tools.
fn success(value: impl serde::Serialize) -> Result<CallToolResult, McpError> {
    let value = serde_json::to_value(value).map_err(internal)?;
    if value.is_object() {
        return Ok(CallToolResult::structured(value));
    }
    Ok(CallToolResult::success(vec![Content::text(
        serde_json::to_string_pretty(&value).map_err(internal)?,
    )]))
}
#[derive(Deserialize, JsonSchema)]
struct ProjectInput {
    /// Project id from list_projects, or its exact name.
    project: String,
}
#[derive(Deserialize, JsonSchema)]
struct TaskInput {
    /// Project id from list_projects, or its exact name.
    project: String,
    /// Task id from list_tasks, or its exact name.
    task: String,
}
#[derive(Deserialize, JsonSchema)]
struct CreateTaskInput {
    /// Project id from list_projects, or its exact name.
    project: String,
    name: String,
    notes: Option<String>,
    #[serde(flatten)]
    files: FilesInput,
}
/// Files to hand on with a message or a new Task.
#[derive(Deserialize, JsonSchema, Default)]
struct FilesInput {
    /// Absolute paths (or file:// URIs) of files to attach, e.g. paths listed by read_session.
    #[serde(default)]
    attachments: Vec<String>,
    /// Attach the images and files from the user's most recent message to you that had any.
    #[serde(default)]
    forward_user_attachments: bool,
}
impl FilesInput {
    fn resolve(
        &self,
        buddy: &crate::storage::buddies::Buddy,
        session: &str,
    ) -> Result<Vec<crate::buddy::attachments::Outgoing>, McpError> {
        let mut files = Vec::new();
        if self.forward_user_attachments {
            files.extend(
                crate::buddy::attachments::latest_from_user(
                    &buddy.project_hash,
                    &crate::buddy::group::session_task(session),
                    session,
                )
                .map_err(|e| McpError::invalid_params(e.to_string(), None))?,
            );
        }
        files.extend(
            crate::buddy::attachments::from_paths(&self.attachments)
                .map_err(|e| McpError::invalid_params(e.to_string(), None))?,
        );
        Ok(files)
    }
}
#[derive(Deserialize, JsonSchema)]
struct SendInput {
    /// What to say. For a new Session, this is the full brief.
    text: String,
    /// An existing Session ID to message.
    #[serde(default)]
    session: Option<String>,
    /// Start a new Session instead.
    #[serde(default)]
    new: Option<NewSessionInput>,
    /// Report the outcome back to you (default true). false just delivers.
    #[serde(default = "follow_default")]
    follow: bool,
    /// Stop the target Session's current turn so it gets to your message now
    /// instead of when that turn ends. The Session keeps its context.
    #[serde(default)]
    interrupt: bool,
    #[serde(flatten)]
    files: FilesInput,
}
fn follow_default() -> bool {
    true
}

#[derive(Deserialize, JsonSchema)]
struct StayQuietInput {
    /// A few words on why this doesn't need the user, shown beside the quiet turn.
    reason: String,
}

#[derive(Deserialize, JsonSchema)]
struct NewSessionInput {
    title: String,
    target: crate::buddy::delegations::Target,
}

#[derive(Deserialize, JsonSchema)]
struct MessageBuddyInput {
    /// The Buddy's id from list_buddies, or its exact name.
    buddy: String,
    /// What to say.
    text: String,
    /// When answering a Buddy's message, its message id.
    #[serde(default)]
    reply_to: Option<String>,
}

#[derive(Deserialize, JsonSchema)]
struct FollowupId {
    id: String,
}

#[derive(Deserialize, JsonSchema)]
struct RoutineId {
    id: String,
}
#[derive(Deserialize, JsonSchema)]
struct RoutineUpdate {
    id: String,
    #[serde(flatten)]
    patch: crate::buddy::routines::RoutinePatch,
}

#[tool_router]
impl BuddyMcpService {
    #[tool(
        name = "create_routine",
        description = "Create a scheduled prompt for this Buddy: recurring (schedule_cron, optionally bounded by starts_at / ends_at) or one-time (run_once_at). Timestamps are unix seconds. Runs always use the current Segment and Agent settings."
    )]
    async fn routine_create(
        &self,
        Parameters(input): Parameters<crate::buddy::routines::RoutineInput>,
        Extension(parts): Extension<Parts>,
    ) -> Result<CallToolResult, McpError> {
        let (buddy, _) = caller(&parts)?;
        success(crate::buddy::routines::save(&buddy, None, input).map_err(internal)?)
    }
    #[tool(
        name = "list_routines",
        description = "List this Buddy's user-managed Routines. Memory organization is managed separately."
    )]
    async fn routine_list(
        &self,
        Extension(parts): Extension<Parts>,
    ) -> Result<CallToolResult, McpError> {
        let (buddy, _) = caller(&parts)?;
        success(crate::buddy::routines::list(&buddy).map_err(internal)?)
    }
    #[tool(
        name = "update_routine",
        description = "Update a Routine owned by this Buddy. Pass only what changes; everything else stays as it is. Set enabled to turn it on or off. Pass null for run_once_at, starts_at or ends_at to clear it."
    )]
    async fn routine_update(
        &self,
        Parameters(input): Parameters<RoutineUpdate>,
        Extension(parts): Extension<Parts>,
    ) -> Result<CallToolResult, McpError> {
        let (buddy, _) = caller(&parts)?;
        success(crate::buddy::routines::update(&buddy, &input.id, input.patch).map_err(internal)?)
    }
    #[tool(
        name = "delete_routine",
        description = "Delete a Routine owned by this Buddy. Cannot delete Memory organization."
    )]
    async fn routine_delete(
        &self,
        Parameters(input): Parameters<RoutineId>,
        Extension(parts): Extension<Parts>,
    ) -> Result<CallToolResult, McpError> {
        let (buddy, _) = caller(&parts)?;
        crate::buddy::routines::delete(&buddy, &input.id).map_err(internal)?;
        success(serde_json::json!({"deleted":true}))
    }
    #[tool(
        name = "run_routine",
        description = "Trigger this Buddy's Routine now, using the current Segment."
    )]
    async fn routine_run(
        &self,
        Parameters(input): Parameters<RoutineId>,
        Extension(parts): Extension<Parts>,
    ) -> Result<CallToolResult, McpError> {
        let (buddy, _) = caller(&parts)?;
        let routine = crate::buddy::routines::get(&buddy, &input.id).map_err(internal)?;
        let result = crate::automation::executor::run(&routine, "manual").await;
        success(
            serde_json::json!({"run_id":result.run_id,"status":result.status,"error":result.error,"session":result.resolved_chat_id}),
        )
    }
    #[tool(
        name = "send",
        description = "Send work or a message to a Session and, by default, get its outcome back. Pass session to message an existing Session (any Task or Project), or new to start one: target self for light research in your Local Task, task for an existing Task, new_task to create one; code changes belong in a Task of the target Project. Results, failures and requests waiting for approval or input come back to you as messages; do not poll. A message to a busy Session waits until its current turn ends; set interrupt to stop that turn. Files the user sent you are not passed on by themselves: set forward_user_attachments to hand on their latest attachments, or list paths in attachments."
    )]
    async fn send(
        &self,
        Parameters(input): Parameters<SendInput>,
        Extension(parts): Extension<Parts>,
    ) -> Result<CallToolResult, McpError> {
        let (buddy, session) = caller(&parts)?;
        let files = input.files.resolve(&buddy, &session)?;
        let running = match input.session.as_deref().filter(|_| input.interrupt) {
            Some(target) => crate::buddy::tools::running_session(target).map_err(internal)?,
            None => None,
        };
        let result = match (input.session, input.new) {
            (Some(target), None) if input.follow => {
                let (followup, message_id) = crate::buddy::delegations::follow(
                    &buddy,
                    &session,
                    &target,
                    &input.text,
                    &files,
                )
                .await
                .map_err(internal)?;
                serde_json::json!({"message_id":message_id,"followup":followup})
            }
            (Some(target), None) => {
                let message_id = crate::buddy::tools::send(&buddy, &target, &input.text, &files)
                    .await
                    .map_err(internal)?;
                serde_json::json!({"message_id":message_id})
            }
            (None, Some(new)) => {
                let followup = crate::buddy::delegations::delegate(
                    &buddy,
                    &session,
                    crate::buddy::delegations::DelegateInput {
                        title: new.title,
                        brief: input.text,
                        target: new.target,
                        files,
                    },
                )
                .await
                .map_err(internal)?;
                serde_json::json!({"message_id":followup.round_message_id,"followup":followup})
            }
            _ => {
                return Err(McpError::invalid_params(
                    "Pass exactly one of session or new",
                    None,
                ))
            }
        };
        // After sending, so the follow-up already waits on the new message.
        if let Some(handle) = running {
            handle.cancel().await.map_err(internal)?;
        }
        success(result)
    }
    #[tool(
        name = "list_buddies",
        description = "List the user's other Buddies: id, name, role and whether each is idle, running or waiting."
    )]
    async fn list_buddies(
        &self,
        Extension(parts): Extension<Parts>,
    ) -> Result<CallToolResult, McpError> {
        let (buddy, _) = caller(&parts)?;
        success(crate::buddy::chat::list(&buddy).map_err(internal)?)
    }
    #[tool(
        name = "message_buddy",
        description = "Send a message to another of the user's Buddies. It arrives in their conversation, waiting until they are free; they answer with message_buddy and reply_to only if a reply is useful. Use it to ask or tell another Buddy something in their area; hand real work to Sessions with send. Don't reply just to acknowledge, and after a few messages back and forth without the user, stop and tell the user instead."
    )]
    async fn message_buddy(
        &self,
        Parameters(input): Parameters<MessageBuddyInput>,
        Extension(parts): Extension<Parts>,
    ) -> Result<CallToolResult, McpError> {
        let (buddy, session) = caller(&parts)?;
        success(
            crate::buddy::chat::send(
                &buddy,
                &session,
                &input.buddy,
                &input.text,
                input.reply_to.as_deref(),
            )
            .await
            .map_err(invalid)?,
        )
    }
    #[tool(
        name = "list_followups",
        description = "List the Sessions you are following and their last status/result. After a Grove restart, unfinished ones are marked interrupted; check the Session and send again if needed."
    )]
    async fn followups(
        &self,
        Extension(parts): Extension<Parts>,
    ) -> Result<CallToolResult, McpError> {
        let (buddy, _) = caller(&parts)?;
        success(
            crate::storage::buddies::list_delegations(
                &crate::storage::database::connection(),
                &buddy.id,
            )
            .map_err(internal)?,
        )
    }
    #[tool(
        name = "cancel_followup",
        description = "Stop a follow-up: cancels the target Session's current turn and drops your queued messages there. You can message the Session again afterwards."
    )]
    async fn cancel_followup(
        &self,
        Parameters(input): Parameters<FollowupId>,
        Extension(parts): Extension<Parts>,
    ) -> Result<CallToolResult, McpError> {
        let (buddy, _) = caller(&parts)?;
        success(
            crate::buddy::delegations::cancel(&buddy.id, &input.id)
                .await
                .map_err(internal)?,
        )
    }
    #[tool(
        name = "stay_quiet",
        description = "Don't bother the user with this turn: nothing you say in it is shown to them, and they get no notification. Use it when a Routine, another Buddy or a finished Session woke you and the user has nothing to learn or decide. In a group, use it when a message wasn't really for you: nothing goes to the group. You keep working normally, so save anything worth remembering. Refused when the user sent the message or named you in a group, or when a Session failed or is waiting."
    )]
    async fn stay_quiet(
        &self,
        Parameters(input): Parameters<StayQuietInput>,
        Extension(parts): Extension<Parts>,
    ) -> Result<CallToolResult, McpError> {
        let (buddy, session) = caller(&parts)?;
        crate::buddy::quiet::stay_quiet(&buddy, &session, &input.reason).map_err(invalid)?;
        success(serde_json::json!({"quiet":true}))
    }
    #[tool(
        name = "read_group",
        description = "Who is in a group you belong to, what each of them does and whether they are working, plus its messages newest last. Page back with before_seq. Outside a group, leave group empty to list your groups."
    )]
    async fn read_group(
        &self,
        Parameters(input): Parameters<crate::buddy::group::ReadGroupInput>,
        Extension(parts): Extension<Parts>,
    ) -> Result<CallToolResult, McpError> {
        let (buddy, session) = caller(&parts)?;
        success(crate::buddy::group::read(&buddy, &session, input).map_err(invalid)?)
    }
    #[tool(
        name = "manage_queue",
        description = "Work on a Session's queue, as the user can in the composer: edit or remove a queued prompt by its id from read_session, or send_now to stop the current turn so the next queued prompt runs (with nothing queued, this just stops the turn). The result is the queue afterwards."
    )]
    async fn manage_queue(
        &self,
        Parameters(input): Parameters<crate::buddy::tools::ManageQueueInput>,
        Extension(parts): Extension<Parts>,
    ) -> Result<CallToolResult, McpError> {
        let (buddy, _) = caller(&parts)?;
        success(
            crate::buddy::tools::manage_queue(&buddy, input)
                .await
                .map_err(internal)?,
        )
    }
    #[tool(
        name = "respond",
        description = "Answer a request a followed Session is waiting on, using the request_id from its waiting notice. option_id answers a permission (one-time options only); fields answers a form, decline refuses it. Only answer on the user's behalf when they asked you to or it is clearly safe; otherwise tell the user what is being asked."
    )]
    async fn respond(
        &self,
        Parameters(input): Parameters<crate::buddy::delegations::RespondInput>,
        Extension(parts): Extension<Parts>,
    ) -> Result<CallToolResult, McpError> {
        let (buddy, _) = caller(&parts)?;
        success(crate::buddy::delegations::respond(&buddy, input).map_err(internal)?)
    }
    #[tool(
        name = "create_project",
        description = "Create a Project. kind studio needs only a name. kind coding needs a source: new (empty folder name inside parent_dir, optionally git init), existing (register a folder), or clone (a Git URL, cloned into Grove's folder). Local folders must be inside the user's home; confirm the folder with the user first."
    )]
    async fn create_project(
        &self,
        Parameters(input): Parameters<crate::buddy::tools::CreateProjectInput>,
        Extension(parts): Extension<Parts>,
    ) -> Result<CallToolResult, McpError> {
        caller(&parts)?;
        success(
            crate::buddy::tools::create_project(input)
                .await
                .map_err(internal)?,
        )
    }
    #[tool(
        name = "list_projects",
        description = "List all registered ordinary Projects, including archived Projects, each with the id other tools take. Buddy Projects are hidden."
    )]
    async fn list_projects(&self) -> Result<CallToolResult, McpError> {
        success(crate::buddy::tools::list_projects().map_err(internal)?)
    }
    #[tool(name = "list_tasks", description = "List active Tasks in a Project.")]
    async fn list_tasks(
        &self,
        Parameters(input): Parameters<ProjectInput>,
    ) -> Result<CallToolResult, McpError> {
        let project = crate::buddy::tools::resolve_project(&input.project).map_err(invalid)?;
        success(crate::storage::tasks::load_tasks(&project).map_err(internal)?)
    }
    #[tool(
        name = "list_sessions",
        description = "List a Task's Sessions and their idle, running or waiting status."
    )]
    async fn list_sessions(
        &self,
        Parameters(input): Parameters<TaskInput>,
    ) -> Result<CallToolResult, McpError> {
        let project = crate::buddy::tools::resolve_project(&input.project).map_err(invalid)?;
        let task = crate::buddy::tools::resolve_task(&project, &input.task).map_err(invalid)?;
        success(crate::buddy::tools::list_sessions(&project, &task).map_err(internal)?)
    }
    #[tool(
        name = "read_session",
        description = "Read a Session as numbered entries (user and assistant messages; Grove envelopes removed), newest page first. Page with before/after using the returned cursors. include_tools adds one line per tool call and the files touched. Entries list their images and files with paths you can pass to send or create_task as attachments; the page's newest images are shown to you. history_path is the raw event log for grep when you need detail. status says whether the Session is idle, running or waiting; current_prompt is what it is working on; queue lists the prompts waiting behind it, next to run first."
    )]
    async fn read_session(
        &self,
        Parameters(input): Parameters<crate::buddy::tools::ReadSessionInput>,
    ) -> Result<CallToolResult, McpError> {
        let page = crate::buddy::tools::read_session(input).map_err(internal)?;
        let mut result = success(page.value)?;
        result.content.extend(
            page.images
                .into_iter()
                .map(|(data, mime_type)| Content::image(data, mime_type)),
        );
        Ok(result)
    }
    #[tool(
        name = "search_sessions",
        description = "Find messages containing some words in one Session or across a Project's Sessions. Each match gives the Session and entry index; read around it with read_session (before = index + 1)."
    )]
    async fn search_sessions(
        &self,
        Parameters(input): Parameters<crate::buddy::tools::SearchSessionsInput>,
    ) -> Result<CallToolResult, McpError> {
        success(crate::buddy::tools::search_sessions(input).map_err(internal)?)
    }
    #[tool(
        name = "create_task",
        description = "Create a Task in a Repo or Studio Project, optionally with notes and attachments (listed in the notes by path). Code changes must run in a Task of the target Project."
    )]
    async fn create_task(
        &self,
        Parameters(input): Parameters<CreateTaskInput>,
        Extension(parts): Extension<Parts>,
    ) -> Result<CallToolResult, McpError> {
        let (buddy, session) = caller(&parts)?;
        let files = input.files.resolve(&buddy, &session)?;
        success(
            crate::buddy::tools::create_task(
                &buddy,
                &input.project,
                input.name,
                input.notes,
                &files,
            )
            .map_err(internal)?,
        )
    }
}

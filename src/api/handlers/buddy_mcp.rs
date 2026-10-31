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
    let segment = crate::storage::buddies::get_segment(&conn, &session)
        .map_err(internal)?
        .ok_or_else(|| McpError::invalid_request("Not a Buddy Segment", None))?;
    let buddy = crate::storage::buddies::get(&conn, &segment.buddy_id)
        .map_err(internal)?
        .ok_or_else(|| McpError::invalid_request("Buddy not found", None))?;
    Ok((buddy, session))
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
        if request.name.starts_with("buddy_") {
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
        assert!(names.iter().any(|name| name == "buddy_send"));
        assert!(names.iter().all(|name| name.starts_with("buddy_")));
        assert!(!names
            .iter()
            .any(|name| name == "set_title" || name == "grove_complete_task"));
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

fn success(value: impl serde::Serialize) -> Result<CallToolResult, McpError> {
    Ok(CallToolResult::structured(
        serde_json::to_value(value).map_err(internal)?,
    ))
}
#[derive(Deserialize, JsonSchema)]
struct ProjectInput {
    project: String,
}
#[derive(Deserialize, JsonSchema)]
struct TaskInput {
    project: String,
    task: String,
}
#[derive(Deserialize, JsonSchema)]
struct ReadSessionInput {
    session: String,
    tail: Option<usize>,
}
#[derive(Deserialize, JsonSchema)]
struct CreateTaskInput {
    project: String,
    name: String,
    notes: Option<String>,
}
#[derive(Deserialize, JsonSchema)]
struct SendInput {
    session: String,
    text: String,
}

#[derive(Deserialize, JsonSchema)]
struct RoutineId {
    id: String,
}
#[derive(Deserialize, JsonSchema)]
struct RoutineUpdate {
    id: String,
    #[serde(flatten)]
    input: crate::buddy::routines::RoutineInput,
}

#[tool_router]
impl BuddyMcpService {
    #[tool(
        name = "buddy_routine_create",
        description = "Create a recurring prompt for this Buddy. Runs always use the current Segment and Agent settings."
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
        name = "buddy_routine_list",
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
        name = "buddy_routine_update",
        description = "Update a Routine owned by this Buddy."
    )]
    async fn routine_update(
        &self,
        Parameters(input): Parameters<RoutineUpdate>,
        Extension(parts): Extension<Parts>,
    ) -> Result<CallToolResult, McpError> {
        let (buddy, _) = caller(&parts)?;
        success(
            crate::buddy::routines::save(&buddy, Some(&input.id), input.input).map_err(internal)?,
        )
    }
    #[tool(
        name = "buddy_routine_delete",
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
        name = "buddy_routine_run",
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
        name = "buddy_delegate",
        description = "Delegate a whole piece of work to a new ordinary Agent Session. self is for light research; task or new_task places code changes in the target Project. Results return automatically while Grove is running."
    )]
    async fn delegate(
        &self,
        Parameters(input): Parameters<crate::buddy::delegations::DelegateInput>,
        Extension(parts): Extension<Parts>,
    ) -> Result<CallToolResult, McpError> {
        let (buddy, session) = caller(&parts)?;
        success(
            crate::buddy::delegations::delegate(&buddy, &session, input)
                .await
                .map_err(internal)?,
        )
    }
    #[tool(
        name = "buddy_delegations",
        description = "List this Buddy's delegations and their last observed status/result. After restart, status is historical: inspect the target Session and explicitly send or cancel as needed; Grove never replays the brief automatically."
    )]
    async fn delegations(
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
        name = "buddy_list_projects",
        description = "List all registered ordinary Projects, including archived Projects. Buddy Projects are hidden."
    )]
    async fn list_projects(&self) -> Result<CallToolResult, McpError> {
        success(crate::storage::workspace::load_projects().map_err(internal)?)
    }
    #[tool(
        name = "buddy_list_tasks",
        description = "List active Tasks in a Project."
    )]
    async fn list_tasks(
        &self,
        Parameters(input): Parameters<ProjectInput>,
    ) -> Result<CallToolResult, McpError> {
        success(crate::storage::tasks::load_tasks(&input.project).map_err(internal)?)
    }
    #[tool(
        name = "buddy_list_sessions",
        description = "List a Task's Sessions and their idle, running or waiting status."
    )]
    async fn list_sessions(
        &self,
        Parameters(input): Parameters<TaskInput>,
    ) -> Result<CallToolResult, McpError> {
        success(crate::buddy::tools::list_sessions(&input.project, &input.task).map_err(internal)?)
    }
    #[tool(
        name = "buddy_read_session",
        description = "Read any Session's metadata, absolute history path and total line count. Optionally return the last 0 to 200 user/assistant messages."
    )]
    async fn read_session(
        &self,
        Parameters(input): Parameters<ReadSessionInput>,
    ) -> Result<CallToolResult, McpError> {
        success(crate::buddy::tools::read_session(&input.session, input.tail).map_err(internal)?)
    }
    #[tool(
        name = "buddy_create_task",
        description = "Create a Task in a Repo or Studio Project, optionally with notes. Code changes must run in a Task of the target Project."
    )]
    async fn create_task(
        &self,
        Parameters(input): Parameters<CreateTaskInput>,
        Extension(parts): Extension<Parts>,
    ) -> Result<CallToolResult, McpError> {
        let (buddy, _) = caller(&parts)?;
        success(
            crate::buddy::tools::create_task(&buddy, &input.project, input.name, input.notes)
                .map_err(internal)?,
        )
    }
    #[tool(
        name = "buddy_send",
        description = "Send a message to any writable Session, including a Session in another Task or Project. Busy Sessions queue the message. Ended Buddy Segments are read-only."
    )]
    async fn send(
        &self,
        Parameters(input): Parameters<SendInput>,
        Extension(parts): Extension<Parts>,
    ) -> Result<CallToolResult, McpError> {
        let (buddy, _) = caller(&parts)?;
        let message_id = crate::buddy::tools::send(&buddy, &input.session, &input.text)
            .await
            .map_err(internal)?;
        success(serde_json::json!({"message_id": message_id}))
    }
}

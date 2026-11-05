//! The plugin host API: what a plugin may ask Grove to do, whichever of its
//! surfaces asks.
//!
//! Panels (via `POST /plugins/{id}/host`), MCP servers (via the token-gated
//! loopback route) and backends (over their stdio pipe) all land in [`call`],
//! so a capability behaves the same everywhere and its permission is checked
//! here, on the server. The operations themselves are the trusted ones Buddy
//! tools already use; this layer only adds plugin identity and permissions.

use serde::Deserialize;
use serde_json::{json, Value};

use crate::agent_graph::inject::PluginMeta;
use crate::buddy::tools;
use crate::error::{GroveError, Result};
use crate::storage::plugins::Plugin;
use crate::storage::{buddies, comments, database, memory, notes, tasks};

/// The permission each host method needs. A method absent here does not exist.
fn required_permission(method: &str) -> Option<&'static str> {
    Some(match method {
        "workspace.projects" | "workspace.tasks" => "workspace:read",
        "sessions.list" | "sessions.read" | "sessions.search" => "sessions:read",
        "sessions.send" => "sessions:write",
        "buddies.list" => "buddies:read",
        "buddies.send" => "buddies:write",
        "interaction.askForm" => "ui:interact",
        "view.list" => "view:list",
        "memory.list" | "memory.read" => "memory:read",
        "memory.appendLog" => "memory:write",
        "notes.read" => "notes:read",
        "notes.write" => "notes:write",
        "review.list" => "review:read",
        "routines.list" => "buddies:read",
        "groups.send" => "buddies:write",
        _ => return None,
    })
}

/// Every host method, for checks that its docs and schema keep up.
#[cfg(test)]
pub(crate) const METHODS: [&str; 18] = [
    "memory.list",
    "memory.read",
    "memory.appendLog",
    "notes.read",
    "notes.write",
    "review.list",
    "routines.list",
    "groups.send",
    "workspace.projects",
    "workspace.tasks",
    "sessions.list",
    "sessions.read",
    "sessions.search",
    "sessions.send",
    "buddies.list",
    "buddies.send",
    "interaction.askForm",
    "view.list",
];

#[cfg(test)]
pub(crate) fn permission_of(method: &str) -> Option<&'static str> {
    required_permission(method)
}

/// Whether `method` belongs to this API (others go to their own handlers).
pub fn handles(method: &str) -> bool {
    required_permission(method).is_some()
}

fn declared_permissions(plugin: &Plugin) -> Vec<String> {
    std::fs::read_to_string(std::path::Path::new(&plugin.local_path).join("plugin.json"))
        .ok()
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .and_then(|manifest| {
            manifest
                .get("permissions")
                .and_then(Value::as_array)
                .map(|items| {
                    items
                        .iter()
                        .filter_map(|item| item.as_str().map(String::from))
                        .collect()
                })
        })
        .unwrap_or_default()
}

/// The active plugin behind `plugin_id`, if it holds `permission`.
fn authorize(plugin_id: &str, permission: &str) -> Result<Plugin> {
    let plugin = crate::storage::plugins::get(plugin_id)?
        .ok_or_else(|| GroveError::not_found(format!("plugin not found: {plugin_id}")))?;
    if !super::approval::is_active(&plugin) {
        return Err(GroveError::invalid_data(format!(
            "plugin \"{}\" is awaiting approval",
            plugin.name
        )));
    }
    if !declared_permissions(&plugin)
        .iter()
        .any(|p| p == permission)
    {
        return Err(GroveError::invalid_data(format!(
            "plugin did not declare the \"{permission}\" permission"
        )));
    }
    Ok(plugin)
}

fn parse<T: serde::de::DeserializeOwned>(params: Value) -> Result<T> {
    serde_json::from_value(params)
        .map_err(|error| GroveError::invalid_data(format!("invalid parameters: {error}")))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectParams {
    project_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TaskParams {
    project_id: String,
    task_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReadParams {
    session_id: String,
    limit: Option<usize>,
    before: Option<usize>,
    after: Option<usize>,
    #[serde(default)]
    include_tools: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SearchParams {
    query: String,
    session_id: Option<String>,
    project_id: Option<String>,
    limit: Option<usize>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SendParams {
    project_id: String,
    task_id: String,
    chat_id: String,
    text: String,
    #[serde(default)]
    meta: Vec<PluginMeta>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BuddySendParams {
    buddy_id: String,
    text: String,
    #[serde(default)]
    meta: Vec<PluginMeta>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MemoryListParams {
    project_id: String,
    query: Option<String>,
    cursor: Option<String>,
    limit: Option<usize>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MemoryReadParams {
    project_id: String,
    entity_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MemoryLogParams {
    project_id: String,
    task_id: String,
    chat_id: Option<String>,
    title: String,
    description: String,
    #[serde(default)]
    tags: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct NotesWriteParams {
    project_id: String,
    task_id: String,
    content: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BuddyParams {
    buddy_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GroupSendParams {
    group_id: String,
    text: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AskFormParams {
    project_id: String,
    task_id: String,
    chat_id: String,
    #[serde(flatten)]
    form: crate::agent_graph::ask_form::AskFormInput,
}

fn list_tasks(project: &str) -> Result<Value> {
    let project = tools::resolve_project(project)?;
    Ok(json!(tasks::load_tasks(&project)?
        .into_iter()
        .map(|task| json!({
            "id": task.id,
            "name": task.name,
            "branch": task.branch,
            "target": task.target,
            "status": task.status,
            "updatedAt": task.updated_at,
        }))
        .collect::<Vec<_>>()))
}

fn list_buddies() -> Result<Value> {
    // Release the connection before naming: the persona lookup takes it again.
    let rows = buddies::list(&database::connection(), false)?;
    Ok(json!(rows
        .iter()
        .map(|buddy| {
            let persona = crate::storage::custom_agent::get(&buddy.custom_agent_id)
                .ok()
                .flatten();
            let status = buddy.active_session_id.as_deref().map_or("idle", |session| {
                tools::session_status(&buddy.project_hash, tasks::LOCAL_TASK_ID, session)
            });
            json!({
                "id": buddy.id,
                "name": persona.as_ref().map_or("Buddy", |p| p.name.as_str()),
                "role": persona.as_ref().and_then(|p| p.duty.clone()).filter(|role| !role.is_empty()),
                "description": buddy.description,
                "status": status,
                "sessionId": buddy.active_session_id,
            })
        })
        .collect::<Vec<_>>()))
}

fn require_text(text: &str, meta: &[PluginMeta]) -> Result<()> {
    if text.trim().is_empty() && meta.is_empty() {
        return Err(GroveError::invalid_data("text must not be empty"));
    }
    Ok(())
}

fn envelope(plugin: &Plugin, text: &str, meta: &[PluginMeta]) -> Result<String> {
    crate::agent_graph::inject::build_plugin_inject_prompt(&plugin.id, &plugin.name, text, meta)
        .map_err(GroveError::invalid_data)
}

async fn send_to_session(plugin: &Plugin, input: SendParams) -> Result<Value> {
    require_text(&input.text, &input.meta)?;
    let body = envelope(plugin, &input.text, &input.meta)?;
    crate::agent_graph::user_ops::user_send_message(
        &input.project_id,
        &input.task_id,
        &input.chat_id,
        &body,
    )
    .await
    .map_err(|error| GroveError::invalid_data(format!("could not deliver prompt: {error}")))?;
    Ok(json!({ "ok": true }))
}

async fn send_to_buddy(plugin: &Plugin, input: BuddySendParams) -> Result<Value> {
    require_text(&input.text, &input.meta)?;
    let body = envelope(plugin, &input.text, &input.meta)?;
    let buddy = crate::buddy::get(&input.buddy_id)?;
    // The active Session can change between sends, so it is resolved per call.
    let (session, _admitted) = crate::grove::ensure_buddy_session(&buddy.id)
        .await
        .map_err(GroveError::invalid_data)?;
    crate::agent_graph::user_ops::user_send_message(
        &buddy.project_hash,
        tasks::LOCAL_TASK_ID,
        &session,
        &body,
    )
    .await
    .map_err(|error| GroveError::invalid_data(format!("could not deliver prompt: {error}")))?;
    Ok(json!({ "ok": true, "sessionId": session }))
}

fn neutralize_form_text(text: &str) -> String {
    crate::agent_graph::inject::neutralize_meta_tags(text)
}

/// Run one host call on behalf of `plugin_id`.
pub async fn call(plugin_id: &str, method: &str, params: Value) -> Result<Value> {
    let permission = required_permission(method)
        .ok_or_else(|| GroveError::invalid_data(format!("unknown host method: {method}")))?;
    let plugin = authorize(plugin_id, permission)?;
    match method {
        "workspace.projects" => tools::list_projects(),
        "workspace.tasks" => list_tasks(&parse::<ProjectParams>(params)?.project_id),
        "sessions.list" => {
            let input: TaskParams = parse(params)?;
            let project = tools::resolve_project(&input.project_id)?;
            let task = tools::resolve_task(&project, &input.task_id)?;
            tools::list_sessions(&project, &task)
        }
        "sessions.read" => {
            let input: ReadParams = parse(params)?;
            tools::read_session(tools::ReadSessionInput {
                session: input.session_id,
                limit: input.limit,
                before: input.before,
                after: input.after,
                include_tools: input.include_tools,
                include_images: Some(false),
            })
            .map(|page| page.value)
        }
        "sessions.search" => {
            let input: SearchParams = parse(params)?;
            tools::search_sessions(tools::SearchSessionsInput {
                query: input.query,
                session: input.session_id,
                project: input.project_id,
                limit: input.limit,
            })
        }
        "sessions.send" => send_to_session(&plugin, parse(params)?).await,
        "buddies.list" => list_buddies(),
        "buddies.send" => send_to_buddy(&plugin, parse(params)?).await,
        "interaction.askForm" => {
            let input: AskFormParams = parse(params)?;
            let mut form = input.form;
            form.title = neutralize_form_text(&form.title);
            form.description = form.description.as_deref().map(neutralize_form_text);
            let shown = crate::agent_graph::ask_form::show_form(
                &input.project_id,
                &input.task_id,
                &input.chat_id,
                form,
            )
            .map_err(|error| GroveError::invalid_data(error.to_string()))?;
            Ok(json!({ "formId": shown.form_id }))
        }
        "view.list" => Ok(json!(super::view::list())),
        "memory.list" => {
            let input: MemoryListParams = parse(params)?;
            let project = tools::resolve_project(&input.project_id)?;
            let page = memory::list_entities(
                &project,
                input.query.as_deref(),
                input.cursor.as_deref(),
                input.limit.unwrap_or(20),
            )?;
            Ok(json!(page))
        }
        "memory.read" => {
            let input: MemoryReadParams = parse(params)?;
            let project = tools::resolve_project(&input.project_id)?;
            let entity = memory::read_entity(&project, &input.entity_id, None, 10)?
                .ok_or_else(|| GroveError::not_found("memory not found"))?;
            Ok(json!(entity))
        }
        "memory.appendLog" => {
            let input: MemoryLogParams = parse(params)?;
            let project = tools::resolve_project(&input.project_id)?;
            let task = tools::resolve_task(&project, &input.task_id)?;
            let agent = format!("plugin:{}", plugin.name);
            let log = memory::append_log(&memory::NewMemoryLog {
                project_id: &project,
                task_id: &task,
                chat_id: input.chat_id.as_deref(),
                agent: Some(&agent),
                title: &input.title,
                tags: &input.tags,
                description: &input.description,
            })?;
            Ok(json!(log))
        }
        "notes.read" => {
            let input: TaskParams = parse(params)?;
            let project = tools::resolve_project(&input.project_id)?;
            let task = tools::resolve_task(&project, &input.task_id)?;
            Ok(json!({ "content": notes::load_notes(&project, &task)? }))
        }
        "notes.write" => {
            let input: NotesWriteParams = parse(params)?;
            let project = tools::resolve_project(&input.project_id)?;
            let task = tools::resolve_task(&project, &input.task_id)?;
            notes::save_notes(&project, &task, &input.content)?;
            Ok(json!({ "ok": true }))
        }
        "review.list" => {
            let input: TaskParams = parse(params)?;
            let project = tools::resolve_project(&input.project_id)?;
            let task = tools::resolve_task(&project, &input.task_id)?;
            Ok(json!(comments::load_comments(&project, &task)?))
        }
        "routines.list" => {
            let buddy = crate::buddy::get(&parse::<BuddyParams>(params)?.buddy_id)?;
            Ok(json!(crate::buddy::routines::list(&buddy)?))
        }
        "groups.send" => {
            let input: GroupSendParams = parse(params)?;
            let text = crate::agent_graph::inject::neutralize_meta_tags(&input.text);
            let message = crate::buddy::group::send(&input.group_id, &text, &[])?;
            Ok(json!(message))
        }
        _ => unreachable!("every method with a permission is dispatched"),
    }
}

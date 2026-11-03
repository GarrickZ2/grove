//! Typed REST calls `grove cli` makes against the Grove server.

use serde::Deserialize;

use super::conn::{Conn, Result};

pub const LOCAL_TASK_ID: &str = crate::storage::tasks::LOCAL_TASK_ID;

#[derive(Debug, Clone, Deserialize)]
pub struct Project {
    pub id: String,
    pub name: String,
    pub path: String,
    /// `repo` or `studio`.
    #[serde(default)]
    pub project_type: String,
    #[serde(default)]
    pub task_count: u32,
    #[serde(default)]
    pub live_count: u32,
    #[serde(default)]
    pub archived: bool,
    #[serde(default = "yes")]
    pub exists: bool,
}

fn yes() -> bool {
    true
}

#[derive(Deserialize)]
struct ProjectList {
    projects: Vec<Project>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Task {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub branch: String,
    #[serde(default)]
    pub status: String,
    /// Branch this task merges into.
    #[serde(default)]
    pub target: String,
    #[serde(default)]
    pub additions: u32,
    #[serde(default)]
    pub deletions: u32,
    #[serde(default)]
    pub commits: Vec<serde_json::Value>,
    /// Working directory (the worktree, or the project for its Local Task).
    #[serde(default)]
    pub path: String,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct ProjectDetail {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub path: String,
    /// `repo` or `studio`.
    #[serde(default)]
    pub project_type: String,
    #[serde(default)]
    pub tasks: Vec<Task>,
    #[serde(default)]
    pub local_task: Option<Task>,
}

impl ProjectDetail {
    /// Local Task first, then worktree tasks that can still host a chat.
    pub fn chat_tasks(&self) -> Vec<Task> {
        let mut local = self.local_task.clone().unwrap_or_else(|| Task {
            id: LOCAL_TASK_ID.into(),
            name: String::new(),
            branch: String::new(),
            status: String::new(),
            target: String::new(),
            additions: 0,
            deletions: 0,
            commits: Vec::new(),
            path: self.path.clone(),
        });
        // The server names the Local Task after the project; say what it is.
        local.name = "Local Task".into();
        std::iter::once(local)
            .chain(
                self.tasks
                    .iter()
                    .filter(|task| task.status != "archived")
                    .cloned(),
            )
            .collect()
    }

    pub fn task_name(&self, task_id: &str) -> String {
        if task_id == LOCAL_TASK_ID {
            return "Local Task".into();
        }
        self.tasks
            .iter()
            .find(|task| task.id == task_id)
            .map(|task| task.name.clone())
            .unwrap_or_else(|| task_id.to_string())
    }
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct Chat {
    pub id: String,
    pub title: String,
    pub agent: String,
    #[serde(default)]
    pub created_at: String,
    #[serde(default)]
    pub updated_at: Option<String>,
    #[serde(default)]
    pub pinned: bool,
}

impl Chat {
    pub fn last_active(&self) -> &str {
        self.updated_at.as_deref().unwrap_or(&self.created_at)
    }
}

#[derive(Deserialize)]
struct ChatList {
    chats: Vec<Chat>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Agent {
    pub id: String,
    pub name: String,
}

#[derive(Deserialize)]
struct AgentList {
    agents: Vec<Agent>,
}

#[derive(Debug, Default, Deserialize)]
pub struct HistoryRuntime {
    #[serde(default)]
    pub active: bool,
    #[serde(default)]
    pub busy: Option<bool>,
}

#[derive(Debug, Deserialize)]
pub struct History {
    pub events: Vec<serde_json::Value>,
    #[serde(default)]
    pub omitted_turns: usize,
    #[serde(default)]
    pub runtime: HistoryRuntime,
}

fn seg(value: &str) -> String {
    // Ids are hashes, uuids or `_local`; escape anything else defensively.
    value
        .bytes()
        .map(|byte| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (byte as char).to_string()
            }
            _ => format!("%{byte:02X}"),
        })
        .collect()
}

pub fn chat_path(project: &str, task: &str, chat: &str) -> String {
    format!(
        "/api/v1/projects/{}/tasks/{}/chats/{}",
        seg(project),
        seg(task),
        seg(chat)
    )
}

pub async fn projects(conn: &Conn) -> Result<Vec<Project>> {
    let list: ProjectList = conn.get("/api/v1/projects").await?;
    Ok(list
        .projects
        .into_iter()
        .filter(|project| !project.archived && project.exists)
        .collect())
}

pub async fn project(conn: &Conn, id: &str) -> Result<ProjectDetail> {
    conn.get(&format!("/api/v1/projects/{}", seg(id))).await
}

/// Chats in a task, pinned first then most recently active.
pub async fn chats(conn: &Conn, project: &str, task: &str) -> Result<Vec<Chat>> {
    let list: ChatList = conn
        .get(&format!(
            "/api/v1/projects/{}/tasks/{}/chats",
            seg(project),
            seg(task)
        ))
        .await?;
    Ok(list.chats)
}

pub async fn create_chat(
    conn: &Conn,
    project: &str,
    task: &str,
    agent: Option<&str>,
    title: Option<&str>,
) -> Result<Chat> {
    conn.post(
        &format!(
            "/api/v1/projects/{}/tasks/{}/chats",
            seg(project),
            seg(task)
        ),
        &serde_json::json!({ "agent": agent, "title": title }),
    )
    .await
}

/// Agents a new session can use — installed agents, custom ACP servers from
/// config and Custom Agent personas — with the configured default first.
pub async fn agents(conn: &Conn) -> Result<Vec<Agent>> {
    let installed: AgentList = conn.get("/api/v1/agents/installed").await?;
    let config: serde_json::Value = conn.get("/api/v1/config").await.unwrap_or_default();
    let personas: AgentList = conn
        .get("/api/v1/custom-agents")
        .await
        .unwrap_or(AgentList { agents: Vec::new() });
    let servers: Vec<Agent> = config
        .pointer("/acp/custom_agents")
        .cloned()
        .and_then(|value| serde_json::from_value(value).ok())
        .unwrap_or_default();
    let mut agents: Vec<Agent> = Vec::new();
    for agent in servers
        .into_iter()
        .chain(installed.agents)
        .chain(personas.agents)
    {
        if !agents.iter().any(|known| known.id == agent.id) {
            agents.push(agent);
        }
    }
    if let Some(default) = config
        .pointer("/acp/agent_command")
        .and_then(|v| v.as_str())
    {
        if let Some(index) = agents.iter().position(|agent| agent.id == default) {
            let agent = agents.remove(index);
            agents.insert(0, agent);
        }
    }
    Ok(agents)
}

pub async fn history(
    conn: &Conn,
    project: &str,
    task: &str,
    chat: &str,
    turns: usize,
) -> Result<History> {
    conn.get(&format!(
        "{}/history?include_media=false&recent_turns={turns}",
        chat_path(project, task, chat)
    ))
    .await
}

/// Live state of running chats keyed by chat id: `busy` or
/// `permission_required`. Idle chats are absent.
pub async fn active_chats(conn: &Conn) -> std::collections::HashMap<String, String> {
    let Ok(value) = conn.get::<serde_json::Value>("/api/v1/tray/chats").await else {
        return Default::default();
    };
    value
        .get("chats")
        .and_then(|chats| chats.as_array())
        .into_iter()
        .flatten()
        .filter_map(|chat| {
            let id = chat
                .get("chat_id")
                .or_else(|| chat.get("chatId"))?
                .as_str()?;
            let status = chat.get("status")?.as_str()?;
            matches!(status, "busy" | "permission_required")
                .then(|| (id.to_string(), status.to_string()))
        })
        .collect()
}

fn task_path(project: &str, task: &str) -> String {
    format!("/api/v1/projects/{}/tasks/{}", seg(project), seg(task))
}

pub async fn create_task(conn: &Conn, project: &str, name: &str) -> Result<Task> {
    conn.post(
        &format!("/api/v1/projects/{}/tasks", seg(project)),
        &serde_json::json!({ "name": name }),
    )
    .await
}

pub async fn rename_task(conn: &Conn, project: &str, task: &str, name: &str) -> Result<()> {
    conn.call(
        reqwest::Method::PATCH,
        &task_path(project, task),
        &serde_json::json!({ "name": name }),
    )
    .await
}

/// Archive a task. Without `force` the server refuses when the task has
/// unmerged or uncommitted work, explaining why.
pub async fn archive_task(conn: &Conn, project: &str, task: &str, force: bool) -> Result<()> {
    let path = format!(
        "{}/archive{}",
        task_path(project, task),
        if force { "?force=true" } else { "" }
    );
    conn.call(reqwest::Method::POST, &path, &serde_json::json!({}))
        .await
}

pub async fn rename_chat(
    conn: &Conn,
    project: &str,
    task: &str,
    chat: &str,
    title: &str,
) -> Result<()> {
    conn.call(
        reqwest::Method::PATCH,
        &chat_path(project, task, chat),
        &serde_json::json!({ "title": title }),
    )
    .await
}

pub async fn archive_chat(conn: &Conn, project: &str, task: &str, chat: &str) -> Result<()> {
    conn.call(
        reqwest::Method::POST,
        &format!("{}/archive", chat_path(project, task, chat)),
        &serde_json::json!({}),
    )
    .await
}

pub async fn pin_chat(
    conn: &Conn,
    project: &str,
    task: &str,
    chat: &str,
    pinned: bool,
) -> Result<()> {
    conn.call(
        reqwest::Method::PUT,
        &format!("{}/pin", chat_path(project, task, chat)),
        &serde_json::json!({ "pinned": pinned }),
    )
    .await
}

#[derive(Debug, Clone, Deserialize)]
pub struct Buddy {
    pub id: String,
    /// The Buddy's own project; its session lives in that project's Local Task.
    pub project_hash: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub active_session_id: Option<String>,
    #[serde(default)]
    pub waiting_delegations: u32,
    /// What the Buddy is for (its persona's duty).
    #[serde(default)]
    pub role: Option<String>,
    #[serde(default)]
    pub description: String,
}

pub async fn buddies(conn: &Conn) -> Result<Vec<Buddy>> {
    conn.get("/api/v1/buddies").await
}

pub async fn add_project(conn: &Conn, path: &str) -> Result<Project> {
    conn.post("/api/v1/projects", &serde_json::json!({ "path": path }))
        .await
}

/// Resolve which registered project a directory belongs to (deepest match).
pub fn project_for_dir<'a>(projects: &'a [Project], dir: &std::path::Path) -> Option<&'a Project> {
    let dir = dir.canonicalize().unwrap_or_else(|_| dir.to_path_buf());
    projects
        .iter()
        .filter(|project| {
            let root = std::path::Path::new(&project.path);
            let root = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
            dir.starts_with(&root)
        })
        .max_by_key(|project| project.path.len())
}

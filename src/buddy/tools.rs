//! Trusted Buddy operations shared by MCP and the delegation lifecycle.
use crate::error::{GroveError, Result};
use crate::storage::{buddies::Buddy, tasks, workspace};
use serde_json::{json, Value};

pub fn session_status(project: &str, task: &str, chat: &str) -> &'static str {
    let Some(handle) = crate::acp::get_session_handle(&format!("{project}:{task}:{chat}")) else {
        return "idle";
    };
    if handle.has_pending_input()
        || handle.has_pending_permission()
        || handle.pending_auth.lock().unwrap().is_some()
    {
        "waiting"
    } else if handle.is_busy.load(std::sync::atomic::Ordering::Acquire) {
        "running"
    } else {
        "idle"
    }
}

pub fn list_sessions(project: &str, task: &str) -> Result<Value> {
    // TODO(buddy-session-display): retain ordinary Task listing until the
    // lightweight delegation presentation is decided; no extra filtering.
    let sessions = tasks::load_chat_sessions(project, task)?;
    Ok(json!(sessions
        .into_iter()
        .map(
            |session| json!({"status":session_status(project, task, &session.id),"session":session})
        )
        .collect::<Vec<_>>()))
}

#[derive(Debug, Default, serde::Deserialize, rmcp::schemars::JsonSchema)]
pub struct ReadSessionInput {
    pub session: String,
    /// Entries per page, 1 to 100 (default 20). The last page by default.
    #[serde(default)]
    pub limit: Option<usize>,
    /// Page backward: entries with index lower than this.
    #[serde(default)]
    pub before: Option<usize>,
    /// Page forward: entries with index higher than this.
    #[serde(default)]
    pub after: Option<usize>,
    /// Add one-line tool summaries and the files they touched.
    #[serde(default)]
    pub include_tools: bool,
}

const HISTORY_FORMAT: &str = "history.jsonl holds one JSON event per line, tagged by \"type\" (user_message, message_chunk, tool_call, tool_call_update, permission_request, complete, ...). Search it with grep for a type or text rather than reading it whole.";

/// Read a Session as numbered entries, a page at a time.
pub fn read_session(input: ReadSessionInput) -> Result<Value> {
    // TODO(buddy-history-authorization): MVP permits reading every Session,
    // including private conversations. Add policy only after product agreement.
    let limit = input.limit.unwrap_or(20);
    if !(1..=100).contains(&limit) {
        return Err(GroveError::invalid_data("limit must be between 1 and 100"));
    }
    let (project, task, chat) = tasks::find_chat_session_any(&input.session)?
        .ok_or_else(|| GroveError::not_found("Session not found"))?;
    let entries = super::session_entries(&project, &task, &input.session, input.include_tools);
    let total = entries.len();
    let (start, end) = match (input.before, input.after) {
        (Some(_), Some(_)) => {
            return Err(GroveError::invalid_data("Pass before or after, not both"))
        }
        (Some(before), None) => {
            let end = before.min(total);
            (end.saturating_sub(limit), end)
        }
        (None, Some(after)) => {
            let start = (after + 1).min(total);
            (start, (start + limit).min(total))
        }
        (None, None) => (total.saturating_sub(limit), total),
    };
    let page = &entries[start..end];
    let mut files: Vec<&String> = page.iter().flat_map(|entry| &entry.files).collect();
    files.sort();
    files.dedup();
    let path = crate::storage::chat_history::history_file_path(&project, &task, &input.session);
    Ok(json!({
        "project": project,
        "task": task,
        "session": chat,
        "total": total,
        "entries": page,
        "files": files,
        "before": (start > 0).then_some(start),
        "after": (end < total).then(|| end.saturating_sub(1)),
        "history_path": path,
        "history_format": HISTORY_FORMAT,
    }))
}

#[derive(Debug, serde::Deserialize, rmcp::schemars::JsonSchema)]
pub struct SearchSessionsInput {
    /// Words to find, case-insensitive.
    pub query: String,
    /// Search one Session.
    #[serde(default)]
    pub session: Option<String>,
    /// Or every Session of a Project.
    #[serde(default)]
    pub project: Option<String>,
    /// Maximum matches (default 20, at most 100).
    #[serde(default)]
    pub limit: Option<usize>,
}

fn snippet(text: &str, at: usize, query_len: usize) -> String {
    let mut start = at.saturating_sub(80);
    while !text.is_char_boundary(start) {
        start -= 1;
    }
    let mut end = (at + query_len + 120).min(text.len());
    while !text.is_char_boundary(end) {
        end += 1;
    }
    let mut out = text[start..end].replace('\n', " ");
    if start > 0 {
        out.insert(0, '…');
    }
    if end < text.len() {
        out.push('…');
    }
    out
}

/// Find messages containing `query`; each match gives the index to read around.
pub fn search_sessions(input: SearchSessionsInput) -> Result<Value> {
    let query = input.query.trim().to_lowercase();
    if query.is_empty() {
        return Err(GroveError::invalid_data("query is required"));
    }
    let limit = input.limit.unwrap_or(20).clamp(1, 100);
    let sessions: Vec<(String, String, String, String)> = match (&input.session, &input.project) {
        (Some(session), None) => {
            let (project, task, chat) = tasks::find_chat_session_any(session)?
                .ok_or_else(|| GroveError::not_found("Session not found"))?;
            vec![(project, task, chat.id, chat.title)]
        }
        (None, Some(project)) => tasks::list_project_sessions(project)?
            .into_iter()
            .map(|(task, chat, title)| (project.clone(), task, chat, title))
            .collect(),
        _ => {
            return Err(GroveError::invalid_data(
                "Pass exactly one of session or project",
            ))
        }
    };
    let mut matches = Vec::new();
    'sessions: for (project, task, chat, title) in sessions {
        for entry in super::session_entries(&project, &task, &chat, false) {
            if let Some(at) = entry.text.to_lowercase().find(&query) {
                // Lowercasing can shift byte offsets; fall back to the start.
                let at = if entry.text.is_char_boundary(at) {
                    at
                } else {
                    0
                };
                matches.push(json!({
                    "session": chat,
                    "title": title,
                    "task": task,
                    "index": entry.index,
                    "role": entry.role,
                    "snippet": snippet(&entry.text, at, query.len()),
                }));
                if matches.len() >= limit {
                    break 'sessions;
                }
            }
        }
    }
    Ok(json!({"matches": matches}))
}

pub fn create_task(
    buddy: &Buddy,
    project_id: &str,
    name: String,
    notes: Option<String>,
) -> Result<tasks::Task> {
    let project = workspace::load_project_by_hash(project_id)?
        .ok_or_else(|| GroveError::not_found("Project not found"))?;
    let cfg = crate::storage::config::load_config();
    let owner = format!("buddy:{}", buddy.id);
    let result = match project.project_type {
        workspace::ProjectType::Repo => crate::operations::tasks::create_task(
            &project.path,
            project_id,
            name,
            crate::git::current_branch(&project.path)?,
            &cfg.default_session_type(),
            &cfg.auto_link.patterns,
            &owner,
        )?,
        workspace::ProjectType::Studio => crate::operations::tasks::create_studio_task(
            &project.path,
            project_id,
            name,
            &cfg.default_session_type(),
            &owner,
        )?,
        workspace::ProjectType::Buddy => {
            return Err(GroveError::invalid_data(
                "Use a normal Project for new Tasks",
            ))
        }
    };
    crate::storage::taskgroups::ensure_task_assignment(project_id, &result.task.id, false)?;
    if let Some(notes) = notes {
        crate::storage::notes::save_notes(project_id, &result.task.id, &notes)?;
    }
    Ok(result.task)
}

/// A message from this Buddy, in the standard v1 `<grove-meta>` envelope so
/// every chat surface can badge it instead of showing raw metadata.
pub fn prompt(buddy: &Buddy, text: &str, extra: Value) -> crate::acp::QueuedMessage {
    let name = crate::storage::custom_agent::get(&buddy.custom_agent_id)
        .ok()
        .flatten()
        .map(|persona| persona.name)
        .unwrap_or_else(|| "Buddy".into());
    let mut data = json!({"buddy_id":buddy.id,"name":name,"avatar":buddy.avatar});
    if let (Some(target), Some(extra)) = (data.as_object_mut(), extra.as_object()) {
        target.extend(extra.clone());
    }
    let envelope = json!({
        "v": 1,
        "type": "buddy_message",
        "data": data,
        "system-prompt": format!("Sent by {name}, the user's Buddy."),
    });
    crate::acp::QueuedMessage::new(
        format!("<grove-meta>{envelope}</grove-meta>\n{text}"),
        Vec::new(),
        Some(format!("buddy:{}", buddy.id)),
        false,
        None,
    )
}

#[derive(Debug, serde::Deserialize, rmcp::schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ProjectSource {
    /// Create an empty folder `name` inside `parent_dir`.
    New {
        parent_dir: String,
        #[serde(default = "default_true")]
        init_git: bool,
    },
    /// Register a folder that already exists.
    Existing { path: String },
    /// Clone a Git repository into Grove's clone folder.
    Clone { url: String },
}
fn default_true() -> bool {
    true
}

#[derive(Debug, serde::Deserialize, rmcp::schemars::JsonSchema)]
pub struct CreateProjectInput {
    /// "studio" for a Studio project, "coding" for a code repository.
    pub kind: String,
    pub name: String,
    /// Required for coding projects.
    #[serde(default)]
    pub source: Option<ProjectSource>,
}

/// Local folders must sit inside the user's home and not be the home itself.
fn ensure_user_folder(path: &str) -> Result<std::path::PathBuf> {
    let expanded = crate::storage::workspace::expand_tilde(path);
    let resolved = std::path::Path::new(&expanded)
        .canonicalize()
        .map_err(|_| GroveError::invalid_data(format!("Folder does not exist: {expanded}")))?;
    let home = dirs::home_dir()
        .and_then(|home| home.canonicalize().ok())
        .ok_or_else(|| GroveError::storage("Home folder not found"))?;
    if resolved == home || !resolved.starts_with(&home) {
        return Err(GroveError::invalid_data(
            "Choose a folder inside your home folder, not the home folder itself",
        ));
    }
    Ok(resolved)
}

/// Create or register a Project, as the Projects page does.
pub async fn create_project(input: CreateProjectInput) -> Result<Value> {
    let name = input.name.trim();
    if name.is_empty() {
        return Err(GroveError::invalid_data("name is required"));
    }
    let path = match (input.kind.as_str(), input.source) {
        ("studio", None) => workspace::create_studio_project(name)?,
        ("studio", Some(_)) => {
            return Err(GroveError::invalid_data("Studio projects take only a name"))
        }
        (
            "coding",
            Some(ProjectSource::New {
                parent_dir,
                init_git,
            }),
        ) => {
            let parent = ensure_user_folder(&parent_dir)?;
            crate::operations::projects::create_new_project(
                &parent.to_string_lossy(),
                name,
                init_git,
            )?
        }
        ("coding", Some(ProjectSource::Existing { path })) => {
            let folder = ensure_user_folder(&path)?.to_string_lossy().to_string();
            let resolved = if crate::git::is_git_repo(&folder) {
                let root = crate::git::repo_root(&folder)?;
                crate::git::get_main_repo_path(&root).unwrap_or(root)
            } else {
                folder
            };
            workspace::add_project(name, &resolved)?;
            resolved
        }
        ("coding", Some(ProjectSource::Clone { url })) => {
            crate::operations::projects::clone_project(&url, Some(name)).await?
        }
        ("coding", None) => {
            return Err(GroveError::invalid_data(
                "Coding projects need a source: new, existing or clone",
            ))
        }
        _ => return Err(GroveError::invalid_data("kind must be studio or coding")),
    };
    Ok(json!({"id":workspace::project_hash(&path),"name":name,"path":path,"kind":input.kind}))
}

/// Messaging one of your own Segments would loop the Buddy into itself.
pub fn ensure_not_own_segment(buddy: &Buddy, session: &str) -> Result<()> {
    let segment =
        crate::storage::buddies::get_segment(&crate::storage::database::connection(), session)?;
    if segment.is_some_and(|segment| segment.buddy_id == buddy.id) {
        return Err(GroveError::invalid_data("That is your own conversation"));
    }
    Ok(())
}

/// Deliver without following the outcome.
pub async fn send(buddy: &Buddy, session: &str, text: &str) -> Result<String> {
    if text.trim().is_empty() {
        return Err(GroveError::invalid_data("text is required"));
    }
    ensure_not_own_segment(buddy, session)?;
    let (project, task, _) = tasks::find_chat_session(session)?
        .ok_or_else(|| GroveError::not_found("Session not found"))?;
    let (handle, _activity) =
        crate::agent_graph::tools::ensure_target_handle(&project, &task, session)
            .await
            .map_err(|e| GroveError::storage(e.to_string()))?;
    let message = prompt(buddy, text, json!({}));
    let id = message.id.clone();
    crate::agent_graph::tools::deliver_prompt(&handle, message)
        .await
        .map_err(|e| GroveError::storage(e.to_string()))?;
    Ok(id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn creates_studio_projects_and_keeps_coding_folders_inside_home() {
        let _lock = database::test_lock().lock().await;
        let _store = Store::new();
        let studio = create_project(CreateProjectInput {
            kind: "studio".into(),
            name: "demo1031".into(),
            source: None,
        })
        .await
        .unwrap();
        assert!(
            workspace::load_project_by_hash(studio["id"].as_str().unwrap())
                .unwrap()
                .is_some()
        );
        for path in ["/tmp", "~"] {
            let result = create_project(CreateProjectInput {
                kind: "coding".into(),
                name: "outside".into(),
                source: Some(ProjectSource::Existing { path: path.into() }),
            })
            .await;
            assert!(result.is_err(), "{path} must be refused");
        }
        assert!(create_project(CreateProjectInput {
            kind: "coding".into(),
            name: "no-source".into(),
            source: None,
        })
        .await
        .is_err());
    }
    use crate::storage::{
        buddies::test_support::{seed_buddy, seed_session, Store},
        database,
    };

    #[tokio::test]
    async fn cross_task_delivery_uses_buddy_sender_and_preserves_queue_identity() {
        let _lock = database::test_lock().lock().await;
        let _store = Store::new();
        let buddy = {
            let conn = database::connection();
            let buddy = seed_buddy(&conn, "sender");
            seed_session(&conn, "target-project", "other-task", "target-chat");
            buddy
        };
        let (handle, mut updates, _guard) = crate::acp::new_handle_for_test(
            "target-project:other-task:target-chat",
            "target-project",
            "other-task",
            "target-chat",
        );
        let id = send(&buddy, "target-chat", "hello").await.unwrap();
        let update = tokio::time::timeout(std::time::Duration::from_secs(2), async {
            loop {
                if let crate::acp::AcpUpdate::UserMessage {
                    text,
                    sender,
                    client_message_id,
                    ..
                } = updates.recv().await.unwrap()
                {
                    break (text, sender, client_message_id);
                }
            }
        })
        .await
        .unwrap();
        assert_eq!(update.1.as_deref(), Some("buddy:sender"));
        assert_eq!(update.2.as_deref(), Some(id.as_str()));
        assert!(update.0.contains("<grove-meta>"));
        assert!(update.0.ends_with("hello"));
        handle
            .is_busy
            .store(true, std::sync::atomic::Ordering::Release);
        let queued = send(&buddy, "target-chat", "next").await.unwrap();
        let queue = handle.get_queue();
        assert_eq!(queue.len(), 1);
        assert_eq!(queue[0].id, queued);
        assert_eq!(queue[0].sender.as_deref(), Some("buddy:sender"));
    }

    #[test]
    fn read_history_includes_archived_sessions_and_counts_whole_file() {
        let _lock = database::test_lock().blocking_lock();
        let _store = Store::new();
        let conn = database::connection();
        seed_session(&conn, "other-project", "other-task", "history");
        drop(conn);
        let path = crate::storage::chat_history::history_file_path(
            "other-project",
            "other-task",
            "history",
        );
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let chunk = serde_json::to_string(&crate::acp::AcpUpdate::MessageChunk {
            message_id: None,
            text: "你好".into(),
        })
        .unwrap();
        std::fs::write(&path, format!("{chunk}\n{chunk}\n")).unwrap();
        tasks::archive_chat_session("other-project", "other-task", "history").unwrap();
        let read = |limit, before, after| {
            read_session(ReadSessionInput {
                session: "history".into(),
                limit,
                before,
                after,
                include_tools: false,
            })
        };
        let result = read(Some(1), None, None).unwrap();
        assert_eq!(result["total"], 1);
        assert_eq!(result["history_path"], path.to_string_lossy().as_ref());
        assert_eq!(result["entries"][0]["text"], "你好你好");
        assert!(read(Some(101), None, None).is_err());
        assert!(read(None, Some(1), Some(0)).is_err());
    }

    #[test]
    fn sessions_page_with_tool_summaries_and_search_without_envelopes() {
        let _lock = database::test_lock().blocking_lock();
        let _store = Store::new();
        seed_session(&database::connection(), "paged-project", "task", "paged");
        let path =
            crate::storage::chat_history::history_file_path("paged-project", "task", "paged");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let events = [
            json!({"type":"user_message","text":"<grove-meta>{\"kind\":\"buddy_message\"}</grove-meta>\nFix the login bug"}),
            json!({"type":"tool_call","id":"t1","title":"Edit src/login.rs","locations":[["src/login.rs",null]]}),
            json!({"type":"tool_call_update","id":"t1","status":"completed","content":null,"locations":[]}),
            json!({"type":"message_chunk","text":"Fixed the token refresh."}),
        ];
        let mut lines = events.iter().map(|e| e.to_string()).collect::<Vec<_>>();
        lines.push(
            serde_json::to_string(&crate::acp::AcpUpdate::Complete {
                stop_reason: "end_turn".into(),
                usage: None,
                start_ts: None,
                end_ts: None,
                cost: None,
            })
            .unwrap(),
        );
        std::fs::write(&path, lines.join("\n") + "\n").unwrap();
        let read = |include_tools, limit, before| {
            read_session(ReadSessionInput {
                session: "paged".into(),
                limit,
                before,
                after: None,
                include_tools,
            })
            .unwrap()
        };
        let plain = read(false, None, None);
        assert_eq!(plain["total"], 2);
        assert_eq!(plain["entries"][0]["text"], "Fix the login bug");
        let tools = read(true, Some(2), None);
        assert_eq!(tools["total"], 3);
        assert_eq!(tools["entries"][0]["text"], "Edit src/login.rs ✓");
        assert_eq!(tools["files"][0], "src/login.rs");
        assert_eq!(tools["before"], 1);
        let earlier = read(true, Some(2), Some(1));
        assert_eq!(earlier["entries"][0]["role"], "user");
        let found = search_sessions(SearchSessionsInput {
            query: "TOKEN".into(),
            session: None,
            project: Some("paged-project".into()),
            limit: None,
        })
        .unwrap();
        assert_eq!(found["matches"][0]["index"], 1);
        assert!(found["matches"][0]["snippet"]
            .as_str()
            .unwrap()
            .contains("token refresh"));
    }

    #[test]
    fn local_listing_keeps_segments_and_lightweight_sessions() {
        let _lock = database::test_lock().blocking_lock();
        let _store = Store::new();
        let buddy = {
            let conn = database::connection();
            let buddy = seed_buddy(&conn, "list");
            seed_session(&conn, &buddy.project_hash, tasks::LOCAL_TASK_ID, "light");
            buddy
        };
        assert_eq!(
            list_sessions(&buddy.project_hash, tasks::LOCAL_TASK_ID)
                .unwrap()
                .as_array()
                .unwrap()
                .len(),
            2
        );
    }
}

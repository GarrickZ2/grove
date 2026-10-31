//! Trusted Buddy operations shared by MCP and the delegation lifecycle.
use crate::error::{GroveError, Result};
use crate::storage::{buddies::Buddy, tasks, workspace};
use serde_json::{json, Value};
use std::io::BufRead;

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

pub fn read_session(session: &str, tail: Option<usize>) -> Result<Value> {
    // TODO(buddy-history-authorization): MVP permits reading every Session,
    // including private conversations. Add policy only after product agreement.
    if tail.is_some_and(|n| n > 200) {
        return Err(GroveError::invalid_data("tail must be between 0 and 200"));
    }
    let (project, task, chat) = tasks::find_chat_session_any(session)?
        .ok_or_else(|| GroveError::not_found("Session not found"))?;
    let path = crate::storage::chat_history::history_file_path(&project, &task, session);
    let mut total_lines = 0;
    match std::fs::File::open(&path) {
        Ok(file) => {
            let mut reader = std::io::BufReader::new(file);
            let mut line = Vec::new();
            while reader.read_until(b'\n', &mut line)? > 0 {
                total_lines += 1;
                line.clear();
            }
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(e.into()),
    }
    Ok(
        json!({"project":project,"task":task,"session":chat,"history_path":path,"total_lines":total_lines,
        "tail":tail.map(|limit| super::recent_text(&project, &task, session, limit))}),
    )
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

pub fn prompt(buddy: &Buddy, text: &str, extra: Value) -> crate::acp::QueuedMessage {
    let mut metadata = json!({"kind":"buddy_message","buddy_id":buddy.id});
    if let (Some(target), Some(extra)) = (metadata.as_object_mut(), extra.as_object()) {
        target.extend(extra.clone());
    }
    crate::acp::QueuedMessage::new(
        format!("<grove-meta>{metadata}</grove-meta>\n{text}"),
        Vec::new(),
        Some(format!("buddy:{}", buddy.id)),
        false,
        None,
    )
}

pub async fn send(buddy: &Buddy, session: &str, text: &str) -> Result<String> {
    if text.trim().is_empty() {
        return Err(GroveError::invalid_data("text is required"));
    }
    let delegation = crate::storage::buddies::list_delegations(
        &crate::storage::database::connection(),
        &buddy.id,
    )?
    .into_iter()
    .find(|d| d.target_session == session);
    if let Some(delegation) = delegation {
        return super::delegations::send_round(buddy, &delegation, text, None).await;
    }
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
        let result = read_session("history", Some(1)).unwrap();
        assert_eq!(result["total_lines"], 2);
        assert_eq!(result["history_path"], path.to_string_lossy().as_ref());
        assert_eq!(result["tail"][0], "assistant: 你好你好");
        assert!(read_session("history", Some(201)).is_err());
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

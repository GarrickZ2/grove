//! Buddy lifecycle. Database changes are atomic; runtime admission shares the
//! existing ACP activity gate. No Agent process is launched during creation.

use crate::agent_config::AgentConfigSelection;
use crate::error::{GroveError, Result};
use crate::storage::{buddies as db, custom_agent, database, memory, taskgroups, tasks};
use chrono::Utc;
use once_cell::sync::Lazy;
use rusqlite::Connection;
use serde::Deserialize;
pub mod configuration;
pub mod delegations;
mod instruction;
pub mod preview;
pub mod routines;
pub mod tools;

use std::collections::HashMap;
use std::sync::{Arc, Mutex, Weak};

static GATES: Lazy<Mutex<HashMap<String, Weak<tokio::sync::Mutex<()>>>>> =
    Lazy::new(Mutex::default);

pub(crate) async fn lock(id: &str) -> tokio::sync::OwnedMutexGuard<()> {
    let gate = {
        let mut gates = GATES.lock().unwrap();
        gates.retain(|_, gate| gate.strong_count() > 0);
        if let Some(gate) = gates.get(id).and_then(Weak::upgrade) {
            gate
        } else {
            let gate = Arc::new(tokio::sync::Mutex::new(()));
            gates.insert(id.to_owned(), Arc::downgrade(&gate));
            gate
        }
    };
    gate.lock_owned().await
}

pub(crate) fn get(id: &str) -> Result<db::Buddy> {
    db::get(&*database::try_connection()?, id)?
        .ok_or_else(|| GroveError::not_found("Buddy not found"))
}

pub(crate) async fn lock_session(
    session_id: &str,
) -> Result<Option<tokio::sync::OwnedMutexGuard<()>>> {
    let segment = db::get_segment(&*database::try_connection()?, session_id)?;
    let guard = if let Some(segment) = segment {
        Some(lock(&segment.buddy_id).await)
    } else {
        None
    };
    db::ensure_session_writable(session_id)?;
    Ok(guard)
}

#[derive(Debug, Clone, Deserialize)]
pub struct CreateInput {
    pub name: String,
    #[serde(default)]
    pub avatar: Option<String>,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub role: Option<String>,
    #[serde(default)]
    pub system_prompt: String,
    pub agent: String,
    #[serde(default)]
    pub agent_config: AgentConfigSelection,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub mode: Option<String>,
    #[serde(default)]
    pub effort: Option<String>,
}

fn validate_agent(agent: &str, config: &mut AgentConfigSelection) -> Result<()> {
    if !custom_agent::is_known_base_agent(agent) {
        return Err(GroveError::invalid_data("unknown_base_agent"));
    }
    let agent_id = match config {
        AgentConfigSelection::Default { agent_id }
        | AgentConfigSelection::ConfigOptions { agent_id, .. }
        | AgentConfigSelection::Modes { agent_id, .. } => agent_id,
    };
    if agent_id.as_deref().is_some_and(|id| id != agent) {
        return Err(GroveError::invalid_data(
            "agent_config.agent_id must match agent",
        ));
    }
    *agent_id = Some(agent.to_owned());
    Ok(())
}

pub fn create(mut input: CreateInput) -> Result<db::Buddy> {
    validate_agent(&input.agent, &mut input.agent_config)?;
    if input.name.trim().is_empty() {
        return Err(GroveError::invalid_data("Buddy name is required"));
    }
    let id = uuid::Uuid::new_v4().to_string();
    let path = db::project_directory(&id)?;
    std::fs::create_dir_all(path.parent().expect("Buddy directory has parent"))?;
    // create_dir deliberately refuses an existing directory: cleanup owns only
    // this newly allocated, empty directory, never existing user content.
    std::fs::create_dir(&path)?;
    let result = (|| {
        let conn = database::try_connection()?;
        let tx = conn.unchecked_transaction()?;
        let buddy = create_on(&tx, &id, input)?;
        tx.commit()?;
        Ok(buddy)
    })();
    if result.is_err() {
        let _ = std::fs::remove_dir(&path);
    }
    if result.is_ok() {
        crate::radio::publish(crate::radio::RadioEvent::AgentsChanged);
    }
    result
}

fn create_on(conn: &Connection, id: &str, input: CreateInput) -> Result<db::Buddy> {
    let project = db::insert_project(conn, id, &input.name)?;
    let path = db::project_directory(id)?;
    tasks::add_task_on(
        conn,
        &project,
        tasks::build_local_task(&path.to_string_lossy(), "", "", &input.name),
    )?;
    taskgroups::ensure_task_assignment_on(conn, &project, tasks::LOCAL_TASK_ID, true)?;
    let persona = custom_agent::create_on(
        conn,
        custom_agent::CustomAgentInput {
            name: input.name,
            base_agent: input.agent.clone(),
            agent_config: input.agent_config,
            model: input.model,
            mode: input.mode,
            effort: input.effort,
            duty: input.role,
            system_prompt: input.system_prompt,
        },
    )?;
    let now = Utc::now().to_rfc3339();
    let buddy = db::Buddy {
        id: id.into(),
        project_hash: project,
        custom_agent_id: persona.id.clone(),
        avatar: input.avatar,
        description: input.description,
        active_session_id: None,
        sort_position: None,
        created_at: now.clone(),
        updated_at: now,
    };
    db::insert(conn, &buddy)?;
    new_segment_on(conn, &buddy, &persona.base_agent, 1)?;
    create_memory_on(conn, &buddy, &persona.agent_config)?;
    db::get(conn, id)?.ok_or_else(|| GroveError::storage("Buddy creation failed"))
}

fn new_segment_on(conn: &Connection, buddy: &db::Buddy, agent: &str, seq: i64) -> Result<String> {
    let id = tasks::generate_chat_id();
    let now = Utc::now();
    tasks::add_chat_session_on(
        conn,
        &buddy.project_hash,
        tasks::LOCAL_TASK_ID,
        tasks::ChatSession {
            id: id.clone(),
            title: "Buddy".into(),
            agent: buddy.custom_agent_id.clone(),
            acp_session_id: None,
            created_at: now,
            duty: None,
            launch_mode: "acp".into(),
        },
    )?;
    db::insert_segment(
        conn,
        &db::Segment {
            session_id: id.clone(),
            buddy_id: buddy.id.clone(),
            seq,
            agent: agent.into(),
            started_at: now.to_rfc3339(),
            ended_at: None,
        },
    )?;
    if !db::set_active_segment(conn, &buddy.id, buddy.active_session_id.as_deref(), &id)? {
        return Err(GroveError::storage("Buddy active Segment changed"));
    }
    Ok(id)
}

fn create_memory_on(
    conn: &Connection,
    buddy: &db::Buddy,
    config: &AgentConfigSelection,
) -> Result<()> {
    use crate::storage::automations::{self, Automation, TargetMode};
    let now = Utc::now();
    let cron = "0 2 * * *";
    let automation = Automation {
        id: automations::generate_id(),
        project: buddy.project_hash.clone(),
        name: "Memory Organization".into(),
        enabled: true,
        handler_key: automations::MEMORY_ORGANIZATION_HANDLER.into(),
        agent_config: config.clone(),
        task_mode: TargetMode::Existing,
        task_id: None,
        task_template: None,
        session_mode: TargetMode::Existing,
        chat_id: None,
        session_template: None,
        prompt: crate::memory::organization::ORGANIZATION_PROMPT.into(),
        schedule_cron: cron.into(),
        event_triggers: Vec::new(),
        last_run_at: None,
        last_run_status: None,
        last_run_error: None,
        next_run_at: crate::automation::cron_util::next_unix(cron)
            .map_err(GroveError::invalid_data)?,
        created_at: now.timestamp(),
        updated_at: now.timestamp(),
    };
    memory::save_project_config_with_automation_on(
        conn,
        &memory::MemoryProjectConfig {
            project_id: buddy.project_hash.clone(),
            enabled: true,
            deep_organization: false,
            pending_log_threshold: None,
            organization_automation_id: automation.id.clone(),
            last_input_through_at: None,
            created_at: now.to_rfc3339(),
            updated_at: now.to_rfc3339(),
        },
        &automation,
    )
}

pub async fn switch_agent(
    id: &str,
    agent: &str,
    mut config: AgentConfigSelection,
) -> Result<db::Buddy> {
    validate_agent(agent, &mut config)?;
    let _gate = lock(id).await;
    let buddy = get(id)?;
    let old = buddy
        .active_session_id
        .as_deref()
        .ok_or_else(|| GroveError::storage("Buddy has no active Segment"))?;
    let key = format!("{}:{}:{}", buddy.project_hash, tasks::LOCAL_TASK_ID, old);
    if let Some(handle) = crate::acp::get_session_handle(&key) {
        if !handle.try_retire_for_buddy_switch() {
            return Err(GroveError::storage_tagged("buddy_busy", "Buddy is busy"));
        }
        handle.request_shutdown();
        tokio::time::timeout(std::time::Duration::from_secs(30), async {
            while crate::acp::session_exists(&key) {
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            }
        })
        .await
        .map_err(|_| GroveError::storage_tagged("buddy_busy", "Buddy runtime is still stopping"))?;
    } else if crate::acp::session_start_pending(&key) {
        // A cancelled caller does not cancel the thread-owned startup claim.
        return Err(GroveError::storage_tagged(
            "buddy_busy",
            "Buddy runtime is still starting or stopping",
        ));
    }
    let result = switch_on(&*database::try_connection()?, &buddy, agent, config)?;
    preview::invalidate(old);
    crate::radio::publish(crate::radio::RadioEvent::AgentsChanged);
    Ok(result)
}

pub(crate) fn switch_on(
    conn: &Connection,
    buddy: &db::Buddy,
    agent: &str,
    config: AgentConfigSelection,
) -> Result<db::Buddy> {
    let tx = conn.unchecked_transaction()?;
    let old = buddy
        .active_session_id
        .as_deref()
        .ok_or_else(|| GroveError::storage("Missing active Segment"))?;
    let segment =
        db::get_segment(&tx, old)?.ok_or_else(|| GroveError::storage("Missing Segment"))?;
    if !db::end_segment(&tx, &buddy.id, old, &Utc::now().to_rfc3339())? {
        return Err(GroveError::storage("Segment already ended"));
    }
    custom_agent::update_on(
        &tx,
        &buddy.custom_agent_id,
        custom_agent::CustomAgentPatch {
            base_agent: Some(agent.into()),
            agent_config: Some(config.clone()),
            model: Some(None),
            mode: Some(None),
            effort: Some(None),
            ..Default::default()
        },
    )?
    .ok_or_else(|| GroveError::storage("Missing Buddy persona"))?;
    new_segment_on(&tx, buddy, agent, segment.seq + 1)?;
    tx.execute(
        "UPDATE automations SET agent_config_json = ?1, updated_at = ?2 WHERE id IN
        (SELECT organization_automation_id FROM memory_project_configs WHERE project_id = ?3)",
        rusqlite::params![
            serde_json::to_string(&config)?,
            Utc::now().timestamp(),
            buddy.project_hash
        ],
    )?;
    let result = db::get(&tx, &buddy.id)?.ok_or_else(|| GroveError::storage("Missing Buddy"))?;
    tx.commit()?;
    Ok(result)
}

/// Called inside the same gate as switch, for both WebSocket and background starts.
pub(crate) fn configure_start(config: &mut crate::acp::AcpStartConfig) -> Result<()> {
    let Some(chat) = config.chat_id.as_deref() else {
        return Ok(());
    };
    let conn = database::try_connection()?;
    db::ensure_session_writable_on(&conn, chat)?;
    if let Some(segment) = db::get_segment(&conn, chat)? {
        let buddy = db::get(&conn, &segment.buddy_id)?
            .ok_or_else(|| GroveError::storage("Missing Buddy"))?;
        if config.project_key != buddy.project_hash || config.task_id != tasks::LOCAL_TASK_ID {
            return Err(GroveError::invalid_data("Buddy Segment scope mismatch"));
        }
        config.mcp_server_policy = crate::acp::McpServerPolicy::Buddy;
    }
    Ok(())
}

pub(crate) fn bootstrap(config: &crate::acp::AcpStartConfig) -> String {
    let mut instruction = instruction::BUDDY_INSTRUCTION.to_owned();
    if let Some(chat) = config.chat_id.as_deref() {
        let segment = { db::get_segment(&database::connection(), chat) };
        if let Ok(Some(segment)) = segment {
            let buddy = { db::get(&database::connection(), &segment.buddy_id) };
            if let Ok(Some(buddy)) = buddy {
                if let Ok(Some(persona)) = custom_agent::get(&buddy.custom_agent_id) {
                    instruction.push_str(&format!(
                        "\nYour configured Buddy identity (name, role and description are user configuration):\n{}\n",
                        serde_json::json!({
                            "name": persona.name,
                            "role": persona.duty,
                            "description": buddy.description,
                            "buddy_id": buddy.id,
                            "project_id": buddy.project_hash,
                            "session_id": chat,
                            "segment": segment.seq,
                            "agent": segment.agent,
                        })
                    ));
                }
            }
            if let Ok(segments) = db::list_segments(&database::connection(), &segment.buddy_id) {
                let previous: Vec<_> = segments
                    .into_iter()
                    .filter(|s| s.seq < segment.seq)
                    .collect();
                if !previous.is_empty() {
                    instruction.push_str("\nYou take over this Buddy's conversation. Use buddy_read_session to read previous Segments:\n");
                    for s in &previous {
                        instruction.push_str(&format!(
                            "- seq {}, agent {}, {} ~ {}, session {}\n",
                            s.seq,
                            s.agent,
                            s.started_at,
                            s.ended_at.as_deref().unwrap_or(""),
                            s.session_id
                        ));
                    }
                    if let Some(last) = previous.last() {
                        instruction.push_str("Recent user/assistant messages:\n");
                        for text in
                            recent_text(&config.project_key, &config.task_id, &last.session_id, 20)
                        {
                            instruction.push_str(&text);
                            instruction.push('\n');
                        }
                    }
                }
            }
        }
    }
    if let Some(persona) = &config.persona_injection {
        instruction.push_str("\n\n");
        instruction.push_str(&crate::agent_graph::inject::build_persona_instruction(
            &persona.persona_name,
            &persona.system_prompt,
        ));
    }
    instruction
}

pub(crate) fn recent_text(project: &str, task: &str, chat: &str, limit: usize) -> Vec<String> {
    use crate::acp::AcpUpdate;
    let mut messages = Vec::new();
    let mut assistant = String::new();
    let mut v2 = crate::acp::v2_messages::Messages::default();
    let mut v2_indices = HashMap::new();
    for update in crate::storage::chat_history::load_history(project, task, chat) {
        match update {
            AcpUpdate::UserMessage { text, .. } => {
                if !assistant.is_empty() {
                    messages.push(format!("assistant: {}", std::mem::take(&mut assistant)));
                }
                messages.push(format!("user: {text}"));
            }
            AcpUpdate::V2MessageUpdate { update } => {
                v2.apply(&update);
                for message in v2.entries() {
                    let role = match message.kind {
                        crate::acp::v2_messages::MessageKind::User => "user",
                        crate::acp::v2_messages::MessageKind::Agent => "assistant",
                        crate::acp::v2_messages::MessageKind::Thought => continue,
                    };
                    let text = message
                        .content
                        .iter()
                        .filter_map(|content| match content {
                            agent_client_protocol::schema::v2::ContentBlock::Text(text) => {
                                Some(text.text.as_str())
                            }
                            _ => None,
                        })
                        .collect::<String>();
                    let index = *v2_indices
                        .entry((message.kind, message.id.clone()))
                        .or_insert_with(|| {
                            messages.push(String::new());
                            messages.len() - 1
                        });
                    messages[index] = format!("{role}: {text}");
                }
            }
            AcpUpdate::MessageChunk { text, .. } => assistant.push_str(&text),
            AcpUpdate::Complete { .. } if !assistant.is_empty() => {
                messages.push(format!("assistant: {}", std::mem::take(&mut assistant)));
            }
            _ => {}
        }
    }
    if !assistant.is_empty() {
        messages.push(format!("assistant: {assistant}"));
    }
    messages.drain(..messages.len().saturating_sub(limit));
    messages
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::buddies::test_support::{seed_buddy, Store};
    use crate::storage::chat_history;

    fn input() -> CreateInput {
        CreateInput {
            name: "Ada".into(),
            avatar: None,
            description: "Teammate".into(),
            role: Some("Researcher".into()),
            system_prompt: "Be concise".into(),
            agent: "claude-acp".into(),
            agent_config: AgentConfigSelection::Default {
                agent_id: Some("claude-acp".into()),
            },
            model: None,
            mode: None,
            effort: None,
        }
    }

    #[test]
    fn creation_is_one_transaction_including_memory_and_assignment() {
        let _lock = database::test_lock().blocking_lock();
        let _store = Store::new();
        let conn = database::connection();
        let tx = conn.unchecked_transaction().unwrap();
        let buddy = create_on(&tx, "atomic", input()).unwrap();
        let session = buddy.active_session_id.unwrap();
        assert_eq!(db::get_segment(&tx, &session).unwrap().unwrap().seq, 1);
        for table in [
            "projects",
            "tasks",
            "custom_agent",
            "buddies",
            "buddy_segments",
            "session",
            "automations",
            "memory_project_configs",
            "task_group_slots",
        ] {
            assert_eq!(
                tx.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r
                    .get::<_, i64>(0))
                    .unwrap(),
                1,
                "{table}"
            );
        }
        tx.rollback().unwrap();
        for table in [
            "projects",
            "tasks",
            "custom_agent",
            "buddies",
            "session",
            "automations",
            "memory_project_configs",
            "task_group_slots",
        ] {
            assert_eq!(
                conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r
                    .get::<_, i64>(0))
                    .unwrap(),
                0,
                "{table}"
            );
        }
        let tx = conn.unchecked_transaction().unwrap();
        create_on(&tx, "atomic", input()).unwrap();
        tx.commit().unwrap();
        assert!(db::get(&conn, "atomic").unwrap().is_some());
    }

    #[tokio::test]
    async fn switch_preserves_history_bytes_and_acp_id_and_blocks_old_writes() {
        let _lock = database::test_lock().lock().await;
        let _store = Store::new();
        let buddy = {
            let conn = database::connection();
            let tx = conn.unchecked_transaction().unwrap();
            let buddy = create_on(&tx, "switch", input()).unwrap();
            tx.commit().unwrap();
            buddy
        };
        let old = buddy.active_session_id.as_deref().unwrap();
        tasks::update_chat_acp_session_id(
            &buddy.project_hash,
            tasks::LOCAL_TASK_ID,
            old,
            "old-acp-id",
        )
        .unwrap();
        chat_history::append_event(
            &buddy.project_hash,
            tasks::LOCAL_TASK_ID,
            old,
            &crate::acp::AcpUpdate::MessageChunk {
                message_id: None,
                text: "保留全部历史".into(),
            },
        );
        let path = chat_history::history_file_path(&buddy.project_hash, tasks::LOCAL_TASK_ID, old);
        let before = std::fs::read(&path).unwrap();
        let next = switch_on(
            &database::connection(),
            &buddy,
            "codex-acp",
            AgentConfigSelection::Default {
                agent_id: Some("codex-acp".into()),
            },
        )
        .unwrap();
        assert_ne!(next.active_session_id, buddy.active_session_id);
        assert_eq!(
            db::list_segments(&database::connection(), &buddy.id).unwrap()[1].seq,
            2
        );
        assert!(db::ensure_session_writable(old).is_err());
        assert!(tasks::update_chat_acp_session_id(
            &buddy.project_hash,
            tasks::LOCAL_TASK_ID,
            old,
            "bad"
        )
        .is_err());
        let (_, _, chat) = tasks::find_chat_session(old).unwrap().unwrap();
        assert_eq!(chat.acp_session_id.as_deref(), Some("old-acp-id"));
        assert_eq!(chat.agent, "claude-acp");
        assert!(tasks::add_chat_session(&buddy.project_hash, tasks::LOCAL_TASK_ID, chat).is_err());
        assert!(
            tasks::update_chat_title(&buddy.project_hash, tasks::LOCAL_TASK_ID, old, "bad")
                .is_err()
        );
        assert!(crate::agent_graph::tools::ensure_target_handle(
            &buddy.project_hash,
            tasks::LOCAL_TASK_ID,
            old
        )
        .await
        .is_err());
        chat_history::clear_history(&buddy.project_hash, tasks::LOCAL_TASK_ID, old);
        chat_history::compact_history(&buddy.project_hash, tasks::LOCAL_TASK_ID, old);
        chat_history::append_event(
            &buddy.project_hash,
            tasks::LOCAL_TASK_ID,
            old,
            &crate::acp::AcpUpdate::MessageChunk {
                message_id: None,
                text: "bad".into(),
            },
        );
        let after = std::fs::read(path).unwrap();
        assert_eq!(before.len(), after.len());
        assert_eq!(before, after);
    }

    #[tokio::test]
    async fn switch_admission_rejects_busy_pending_and_active_operations() {
        let _lock = database::test_lock().lock().await;
        let _store = Store::new();
        let buddy = seed_buddy(&database::connection(), "busy");
        let chat = buddy.active_session_id.as_deref().unwrap();
        let key = format!("{}:_local:{chat}", buddy.project_hash);
        let (handle, _, _guard) =
            crate::acp::new_handle_for_test(&key, &buddy.project_hash, tasks::LOCAL_TASK_ID, chat);
        handle
            .is_busy
            .store(true, std::sync::atomic::Ordering::Release);
        assert!(!handle.try_retire_for_buddy_switch());
        handle
            .is_busy
            .store(false, std::sync::atomic::Ordering::Release);
        handle.queue_message(crate::acp::QueuedMessage::new(
            "pending".into(),
            Vec::new(),
            None,
            false,
            None,
        ));
        assert!(!handle.try_retire_for_buddy_switch());
        handle.clear_queue();
        let activity = handle.begin_activity().unwrap();
        assert!(!handle.try_retire_for_buddy_switch());
        drop(activity);
        assert!(handle.try_retire_for_buddy_switch());
        assert!(handle.begin_activity().is_err());
        assert!(db::get_segment(&database::connection(), chat)
            .unwrap()
            .unwrap()
            .ended_at
            .is_none());
    }

    fn start_config(project: &str, chat: &str) -> crate::acp::AcpStartConfig {
        crate::acp::AcpStartConfig {
            agent_command: String::new(),
            agent_name: "claude-acp".into(),
            agent_args: Vec::new(),
            working_dir: std::path::PathBuf::new(),
            env_vars: HashMap::new(),
            project_key: project.into(),
            task_id: tasks::LOCAL_TASK_ID.into(),
            chat_id: Some(chat.into()),
            artifact_dir: None,
            additional_mcp_servers: Vec::new(),
            mcp_server_policy: crate::acp::McpServerPolicy::WorkingSession,
            agent_type: "local".into(),
            remote_url: None,
            remote_auth: None,
            suppress_initial_connecting: false,
            import_session: false,
            persona_injection: None,
        }
    }

    #[tokio::test]
    async fn unified_start_checks_membership_and_handover_uses_complete_messages() {
        let _lock = database::test_lock().lock().await;
        let _store = Store::new();
        let buddy = seed_buddy(&database::connection(), "start");
        let old = buddy.active_session_id.as_deref().unwrap();
        let mut config = start_config(&buddy.project_hash, old);
        configure_start(&mut config).unwrap();
        assert_eq!(config.mcp_server_policy, crate::acp::McpServerPolicy::Buddy);
        for text in ["one", "two"] {
            chat_history::append_event(
                &buddy.project_hash,
                tasks::LOCAL_TASK_ID,
                old,
                &crate::acp::AcpUpdate::MessageChunk {
                    message_id: None,
                    text: text.into(),
                },
            );
        }
        let next = switch_on(
            &database::connection(),
            &buddy,
            "codex-acp",
            AgentConfigSelection::default(),
        )
        .unwrap();
        assert!(crate::acp::get_or_start_session(
            format!("{}:_local:{old}", buddy.project_hash),
            config
        )
        .await
        .is_err());
        let mut current = start_config(
            &buddy.project_hash,
            next.active_session_id.as_deref().unwrap(),
        );
        configure_start(&mut current).unwrap();
        let text = bootstrap(&current);
        assert!(text.contains("agent claude-acp"));
        assert!(text.contains("assistant: onetwo"));
        let mut lightweight = start_config(&buddy.project_hash, "lightweight");
        configure_start(&mut lightweight).unwrap();
        assert_eq!(
            lightweight.mcp_server_policy,
            crate::acp::McpServerPolicy::WorkingSession
        );
    }

    #[test]
    fn bootstrap_identity_uses_each_buddys_name_role_and_description_without_persona_text() {
        let _lock = database::test_lock().blocking_lock();
        let _store = Store::new();
        for (id, name, role, description) in [
            (
                "release",
                "发布队友 \"小舟\"",
                "Release Captain",
                "Track release readiness",
            ),
            (
                "research",
                "Research Buddy",
                "Researcher",
                "Compare source evidence",
            ),
        ] {
            let buddy = seed_buddy(&database::connection(), id);
            custom_agent::update(
                &buddy.custom_agent_id,
                custom_agent::CustomAgentPatch {
                    name: Some(name.into()),
                    duty: Some(Some(role.into())),
                    system_prompt: Some(String::new()),
                    ..Default::default()
                },
            )
            .unwrap();
            db::update_profile(&database::connection(), id, None, description).unwrap();
            let chat = buddy.active_session_id.as_deref().unwrap();
            let prompt = bootstrap(&start_config(&buddy.project_hash, chat));
            let identity_line = prompt
                .lines()
                .skip_while(|line| !line.starts_with("Your configured Buddy identity"))
                .nth(1)
                .unwrap();
            let identity: serde_json::Value = serde_json::from_str(identity_line).unwrap();
            assert_eq!(identity["name"], name);
            assert_eq!(identity["role"], role);
            assert_eq!(identity["description"], description);
            assert_eq!(identity["buddy_id"], id);
            assert_eq!(identity["project_id"], buddy.project_hash);
            assert_eq!(identity["session_id"], chat);
            assert_eq!(identity["segment"], 1);
            assert_eq!(identity["agent"], "claude-acp");
        }
    }

    #[test]
    fn buddy_bootstrap_and_persona_survive_session_envelope_without_changing_user_message() {
        let _lock = database::test_lock().blocking_lock();
        let _store = Store::new();
        let buddy = seed_buddy(&database::connection(), "prompt-envelope");
        let mut config = start_config(
            &buddy.project_hash,
            buddy.active_session_id.as_deref().unwrap(),
        );
        configure_start(&mut config).unwrap();
        let persona = custom_agent::get(&buddy.custom_agent_id).unwrap().unwrap();
        let personal_instruction = "Help with releases.\nUse \"ready\" only after checks.";
        config.persona_injection = Some(crate::acp::PersonaInjection {
            persona_id: persona.id,
            persona_name: persona.name,
            base_agent: persona.base_agent,
            system_prompt: personal_instruction.into(),
            agent_config: persona.agent_config,
            model: persona.model,
            mode: persona.mode,
            effort: persona.effort,
        });
        let prompt = bootstrap(&config);
        assert!(prompt.contains("\n\nThe user configured this Agent"));
        assert!(prompt.contains(personal_instruction));
        let body = "hi\n准备好发布了吗？";
        let wire =
            crate::agent_graph::inject::build_session_instruction_prompt("buddy", &prompt, body);
        let (envelope, user_body) = wire.split_once("</grove-meta>\n\n").unwrap();
        let payload: serde_json::Value =
            serde_json::from_str(envelope.strip_prefix("<grove-meta>").unwrap()).unwrap();
        assert_eq!(payload["data"]["kind"], "buddy");
        assert_eq!(payload["system-prompt"], prompt);
        assert_eq!(user_body, body);
    }

    #[test]
    fn failed_switch_rolls_back_end_and_persona() {
        let _lock = database::test_lock().blocking_lock();
        let _store = Store::new();
        let conn = database::connection();
        let buddy = seed_buddy(&conn, "rollback");
        conn.execute_batch("CREATE TRIGGER fail_new_segment BEFORE INSERT ON buddy_segments BEGIN SELECT RAISE(ABORT, 'injected failure'); END;").unwrap();
        assert!(switch_on(&conn, &buddy, "codex-acp", AgentConfigSelection::default()).is_err());
        assert_eq!(db::get(&conn, &buddy.id).unwrap().unwrap(), buddy);
        assert!(
            db::get_segment(&conn, buddy.active_session_id.as_deref().unwrap())
                .unwrap()
                .unwrap()
                .ended_at
                .is_none()
        );
        assert_eq!(
            conn.query_row(
                "SELECT base_agent FROM custom_agent WHERE id=?1",
                [&buddy.custom_agent_id],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
            "claude-acp"
        );
    }
}

/// Memory organization inherits legacy preferences without Buddy personality.
/// Structured selections remain the Automation Run's immutable snapshot.
pub(crate) fn memory_persona(
    automation: &crate::storage::automations::Automation,
) -> Option<crate::acp::PersonaInjection> {
    if automation.handler_key != crate::storage::automations::MEMORY_ORGANIZATION_HANDLER
        || !matches!(
            automation.agent_config,
            AgentConfigSelection::Default { .. }
        )
    {
        return None;
    }
    let buddy = db::get_by_project(&database::connection(), &automation.project)
        .ok()
        .flatten()?;
    let persona = custom_agent::get(&buddy.custom_agent_id).ok().flatten()?;
    if automation.agent_config.agent_id() != Some(persona.base_agent.as_str()) {
        return None;
    }
    Some(crate::acp::PersonaInjection {
        persona_id: persona.id,
        persona_name: persona.name,
        base_agent: persona.base_agent,
        system_prompt: String::new(),
        agent_config: automation.agent_config.clone(),
        model: persona.model,
        mode: persona.mode,
        effort: persona.effort,
    })
}

//! Task agent graph handlers

use axum::{extract::Path, http::StatusCode, Json};

use crate::acp;
use crate::agent_graph::user_ops;
use crate::api::handlers::common;
use crate::storage::skills;
use crate::storage::{agent_graph as graph_db, database, tasks};

use super::types::*;

fn build_graph_response(project_key: &str, task_id: &str) -> Option<GraphResponse> {
    let chats = tasks::load_chat_sessions(project_key, task_id).ok()?;
    let edges = {
        let conn = database::connection();
        graph_db::list_edges_for_task(&conn, project_key, task_id).ok()?
    };
    let pending_messages = {
        let conn = database::connection();
        graph_db::list_pending_for_task(&conn, project_key, task_id).ok()?
    };
    let pending_pairs: std::collections::HashSet<(String, String)> = pending_messages
        .iter()
        .map(|p| (p.from_session.clone(), p.to_session.clone()))
        .collect();

    // Build a name lookup from chat_id → display name.
    let name_map: std::collections::HashMap<String, String> = chats
        .iter()
        .map(|c| (c.id.clone(), c.title.clone()))
        .collect();

    let resolve_name =
        |id: &str| -> String { name_map.get(id).cloned().unwrap_or_else(|| id.to_string()) };

    let make_excerpt = crate::agent_graph::pending_body_excerpt;

    // Index pending messages by (from, to) for edge lookup, and by session for node lookup.
    let pending_by_pair: std::collections::HashMap<
        (String, String),
        &graph_db::AgentPendingMessage,
    > = pending_messages
        .iter()
        .map(|p| ((p.from_session.clone(), p.to_session.clone()), p))
        .collect();

    let mut pending_in_map: std::collections::HashMap<String, usize> =
        std::collections::HashMap::new();
    let mut pending_out_map: std::collections::HashMap<String, usize> =
        std::collections::HashMap::new();
    let mut pending_msgs_map: std::collections::HashMap<String, Vec<PendingMessageInfo>> =
        std::collections::HashMap::new();

    for p in &pending_messages {
        *pending_in_map.entry(p.to_session.clone()).or_insert(0) += 1;
        *pending_out_map.entry(p.from_session.clone()).or_insert(0) += 1;

        let info = PendingMessageInfo {
            from: p.from_session.clone(),
            from_name: resolve_name(&p.from_session),
            to: p.to_session.clone(),
            to_name: resolve_name(&p.to_session),
            body_excerpt: make_excerpt(&p.body),
        };
        pending_msgs_map
            .entry(p.from_session.clone())
            .or_default()
            .push(info.clone());
        pending_msgs_map
            .entry(p.to_session.clone())
            .or_default()
            .push(info);
    }

    let mut nodes = Vec::with_capacity(chats.len());
    let mut node_status_map = std::collections::HashMap::new();

    for chat in &chats {
        let session_key = format!("{}:{}:{}", project_key, task_id, chat.id);
        let status = if let Some(handle) = acp::get_session_handle(&session_key) {
            if handle.is_busy.load(std::sync::atomic::Ordering::Relaxed) {
                "busy"
            } else if handle.has_pending_permission() {
                "permission_required"
            } else {
                "idle"
            }
        } else {
            "disconnected"
        };

        node_status_map.insert(chat.id.clone(), status.to_string());

        nodes.push(GraphNode {
            chat_id: chat.id.clone(),
            name: chat.title.clone(),
            agent: chat.agent.clone(),
            duty: chat.duty.clone(),
            status: status.to_string(),
            pending_in: *pending_in_map.get(&chat.id).unwrap_or(&0),
            pending_out: *pending_out_map.get(&chat.id).unwrap_or(&0),
            pending_messages: pending_msgs_map.remove(&chat.id).unwrap_or_default(),
        });
    }

    let mut graph_edges = Vec::with_capacity(edges.len());
    for edge in &edges {
        let has_pending =
            pending_pairs.contains(&(edge.from_session.clone(), edge.to_session.clone()));
        let state = if has_pending {
            let to_status = node_status_map
                .get(&edge.to_session)
                .map(|s| s.as_str())
                .unwrap_or("disconnected");
            if to_status == "busy" {
                "in_flight"
            } else {
                "blocked"
            }
        } else {
            "idle"
        };

        let pending_message = pending_by_pair
            .get(&(edge.from_session.clone(), edge.to_session.clone()))
            .map(|p| PendingMessageInfo {
                from: p.from_session.clone(),
                from_name: resolve_name(&p.from_session),
                to: p.to_session.clone(),
                to_name: resolve_name(&p.to_session),
                body_excerpt: make_excerpt(&p.body),
            });

        graph_edges.push(GraphEdge {
            edge_id: edge.edge_id,
            from: edge.from_session.clone(),
            to: edge.to_session.clone(),
            purpose: edge.purpose.clone(),
            state: state.to_string(),
            pending_message,
        });
    }

    Some(GraphResponse {
        nodes,
        edges: graph_edges,
    })
}

/// GET /api/v1/projects/{id}/tasks/{taskId}/graph
pub async fn get_task_graph(
    Path((id, task_id)): Path<(String, String)>,
) -> Result<Json<GraphResponse>, StatusCode> {
    let (_project, project_key) = common::find_project_by_id(&id)?;

    let pk = project_key.clone();
    let tid = task_id.clone();

    let result: Option<GraphResponse> =
        tokio::task::spawn_blocking(move || build_graph_response(&pk, &tid))
            .await
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    result.map(Json).ok_or(StatusCode::NOT_FOUND)
}

fn graph_error(code: &str, message: &str) -> (StatusCode, Json<GraphErrorResponse>) {
    let status = match code {
        "name_taken" | "duplicate_edge" => StatusCode::CONFLICT,
        "cycle_would_form"
        | "bidirectional_edge"
        | "same_task_required"
        | "no_pending_to_remind"
        | "target_not_idle"
        | "target_is_busy" => StatusCode::BAD_REQUEST,
        "target_not_found" | "endpoint_not_found" => StatusCode::NOT_FOUND,
        _ => StatusCode::INTERNAL_SERVER_ERROR,
    };
    (
        status,
        Json(GraphErrorResponse {
            error: message.to_string(),
            code: code.to_string(),
        }),
    )
}

/// POST /api/v1/projects/{id}/tasks/{taskId}/graph/spawn
pub async fn graph_spawn(
    Path((id, task_id)): Path<(String, String)>,
    Json(body): Json<SpawnNodeRequest>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<GraphErrorResponse>)> {
    let (_project, project_key) = common::find_project_by_id(&id)
        .map_err(|_| graph_error("target_not_found", "Project not found"))?;

    let pk = project_key.clone();
    let tid = task_id.clone();
    let from = body.from_chat_id.clone();
    let agent = body.agent.clone();
    let name = body.name.clone();
    let duty = body.duty.clone();
    let purpose = body.purpose.clone();

    let result = user_ops::user_spawn_node(
        &pk,
        &tid,
        from.as_deref(),
        &agent,
        &name,
        duty.as_deref(),
        purpose.as_deref(),
    )
    .await;

    match result {
        Ok(r) => Ok(Json(serde_json::json!({
            "chat_id": r.chat_id,
            "name": r.name,
            "duty": r.duty,
            "agent": r.agent,
        }))),
        Err(e) => {
            let code = if e.contains("name_taken") {
                "name_taken"
            } else if e.contains("timeout") {
                "timeout"
            } else if e.contains("agent_spawn") {
                "agent_spawn_failed"
            } else {
                "internal_error"
            };
            Err(graph_error(code, &e))
        }
    }
}

/// POST /api/v1/projects/{id}/tasks/{taskId}/graph/edges
pub async fn graph_add_edge(
    Path((id, task_id)): Path<(String, String)>,
    Json(body): Json<AddEdgeRequest>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<GraphErrorResponse>)> {
    let (_project, project_key) = common::find_project_by_id(&id)
        .map_err(|_| graph_error("target_not_found", "Project not found"))?;

    // H4: 先 add_edge (含 cycle / duplicate / same_task / endpoint 校验)，
    // 校验通过再写 duty。否则 edge 失败时 duty 已被锁住、edge 不存在，
    // 用户该 chat 的 duty 永久无法再设。
    let edge_id = user_ops::user_add_edge(
        &project_key,
        &task_id,
        &body.from,
        &body.to,
        body.purpose.as_deref(),
    )
    .map_err(|e| {
        let code = if e.contains("cycle") {
            "cycle_would_form"
        } else if e.contains("bidirectional") {
            "bidirectional_edge"
        } else if e.contains("duplicate") {
            "duplicate_edge"
        } else if e.contains("same_task") {
            "same_task_required"
        } else if e.contains("not_found") {
            "target_not_found"
        } else {
            "internal_error"
        };
        graph_error(code, &e)
    })?;

    if let Some(ref d) = body.duty {
        let sessions = tasks::load_chat_sessions(&project_key, &task_id).map_err(|_| {
            // edge 已建，duty 还没尝试 — 这里失败也得回滚 edge
            let conn = crate::storage::database::connection();
            let _ = crate::storage::agent_graph::delete_edge(&conn, edge_id);
            graph_error("internal_error", "Failed to load sessions")
        })?;
        if let Some(target) = sessions.iter().find(|s| s.id == body.to) {
            if target.duty.is_none() {
                let duty_res = tasks::update_chat_duty(
                    &project_key,
                    &task_id,
                    &body.to,
                    Some(d.clone()),
                    true, // 用户路径
                );
                if let Err(e) = duty_res {
                    // M-N3: duty 失败时 best-effort 回滚 edge，避免客户端重试
                    // 撞 duplicate_edge 又得手动清理。
                    let conn = crate::storage::database::connection();
                    let _ = crate::storage::agent_graph::delete_edge(&conn, edge_id);
                    return Err(match e.storage_tag() {
                        Some("duty_locked") => graph_error("duty_forbidden", "Duty is locked"),
                        _ => graph_error("internal_error", &e.to_string()),
                    });
                }
            }
        }
    }

    Ok(Json(serde_json::json!({ "edge_id": edge_id })))
}

/// PATCH /api/v1/projects/{id}/tasks/{taskId}/graph/edges/{edge_id}
pub async fn graph_update_edge(
    Path((id, task_id, edge_id_str)): Path<(String, String, String)>,
    Json(body): Json<UpdateEdgePurposeRequest>,
) -> Result<StatusCode, (StatusCode, Json<GraphErrorResponse>)> {
    let edge_id: i64 = edge_id_str
        .parse()
        .map_err(|_| graph_error("bad_request", "edge_id must be a number"))?;
    let (_project, project_key) = common::find_project_by_id(&id)
        .map_err(|_| graph_error("target_not_found", "Project not found"))?;

    let conn = database::connection();
    let edge = graph_db::get_edge(&conn, edge_id)
        .map_err(|_| graph_error("internal_error", "DB error"))?;
    match edge {
        Some(e) if e.task_id == task_id && e.project == project_key => {
            graph_db::update_edge_purpose(&conn, edge_id, body.purpose.as_deref())
                .map_err(|_| graph_error("internal_error", "DB error"))?;
            Ok(StatusCode::NO_CONTENT)
        }
        Some(_) => Err(graph_error(
            "target_not_found",
            "Edge not found in this task",
        )),
        None => Err(graph_error("target_not_found", "Edge not found")),
    }
}

/// DELETE /api/v1/projects/{id}/tasks/{taskId}/graph/edges/{edge_id}
pub async fn graph_delete_edge(
    Path((id, task_id, edge_id_str)): Path<(String, String, String)>,
) -> Result<StatusCode, (StatusCode, Json<GraphErrorResponse>)> {
    let edge_id: i64 = edge_id_str
        .parse()
        .map_err(|_| graph_error("bad_request", "edge_id must be a number"))?;
    let (_project, project_key) = common::find_project_by_id(&id)
        .map_err(|_| graph_error("target_not_found", "Project not found"))?;

    let conn = database::connection();
    let edge = graph_db::get_edge(&conn, edge_id)
        .map_err(|_| graph_error("internal_error", "DB error"))?;
    match edge {
        Some(e) if e.task_id == task_id && e.project == project_key => {
            graph_db::delete_edge(&conn, edge_id)
                .map_err(|_| graph_error("internal_error", "DB error"))?;
            Ok(StatusCode::NO_CONTENT)
        }
        Some(_) => Err(graph_error(
            "target_not_found",
            "Edge not found in this task",
        )),
        None => Err(graph_error("target_not_found", "Edge not found")),
    }
}

/// POST /api/v1/projects/{id}/tasks/{taskId}/graph/edges/{edge_id}/remind
pub async fn graph_remind(
    Path((id, task_id, edge_id_str)): Path<(String, String, String)>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<GraphErrorResponse>)> {
    let edge_id: i64 = match edge_id_str.parse() {
        Ok(v) => v,
        Err(_) => {
            return Err(graph_error("bad_request", "edge_id must be a number"));
        }
    };
    let (_project, project_key) = match common::find_project_by_id(&id) {
        Ok(v) => v,
        Err(_) => {
            return Err(graph_error("target_not_found", "Project not found"));
        }
    };

    let result = user_ops::user_remind(&project_key, &task_id, edge_id).await;
    match result {
        Ok(()) => Ok(Json(serde_json::json!({}))),
        Err(e) => {
            let code = if e.contains("no_pending") {
                "no_pending_to_remind"
            } else if e.contains("busy") {
                "target_is_busy"
            } else if e.contains("not_found") {
                "target_not_found"
            } else if e.contains("timeout") {
                "timeout"
            } else {
                "internal_error"
            };
            Err(graph_error(code, &e))
        }
    }
}

/// PATCH /api/v1/projects/{id}/tasks/{taskId}/graph/chats/{chat_id}/duty
pub async fn graph_update_duty(
    Path((id, task_id, chat_id)): Path<(String, String, String)>,
    Json(body): Json<UpdateChatDutyRequest>,
) -> Result<StatusCode, (StatusCode, Json<GraphErrorResponse>)> {
    let (_project, project_key) = common::find_project_by_id(&id)
        .map_err(|_| graph_error("target_not_found", "Project not found"))?;

    // M9: 用户编辑路径，传 force=true 跳过 duty lock 检查（lock 仅约束 AI）。
    tasks::update_chat_duty(&project_key, &task_id, &chat_id, body.duty.clone(), true).map_err(
        |e| match e.storage_tag() {
            Some("duty_locked") => graph_error("duty_forbidden", "Duty is locked"),
            Some("chat_not_found") => graph_error("target_not_found", "Chat not found"),
            _ => graph_error("internal_error", &e.to_string()),
        },
    )?;

    Ok(StatusCode::NO_CONTENT)
}

/// POST /api/v1/projects/{id}/tasks/{taskId}/graph/chats/{chat_id}/message
///
/// Send a direct user message to a chat from the graph popup card. Mirrors the
/// chat panel's send button — the message is queued if the target session is
/// busy, otherwise sent as a fresh prompt.
pub async fn graph_send_message(
    Path((id, task_id, chat_id)): Path<(String, String, String)>,
    Json(body): Json<SendChatMessageRequest>,
) -> Result<StatusCode, (StatusCode, Json<GraphErrorResponse>)> {
    let (_project, project_key) = common::find_project_by_id(&id)
        .map_err(|_| graph_error("target_not_found", "Project not found"))?;

    let text = body.text.trim();
    if text.is_empty() {
        return Err(graph_error("bad_request", "text must not be empty"));
    }

    let exists = tasks::get_chat_session(&project_key, &task_id, &chat_id)
        .map_err(|e| graph_error("internal_error", &e.to_string()))?
        .is_some();
    if !exists {
        return Err(graph_error("target_not_found", "Chat not found"));
    }

    user_ops::user_send_message(&project_key, &task_id, &chat_id, text)
        .await
        .map_err(|e| {
            let code = if e.contains("target_not_available") {
                "target_not_found"
            } else if e.contains("timeout") {
                "timeout"
            } else {
                "internal_error"
            };
            graph_error(code, &e)
        })?;

    Ok(StatusCode::NO_CONTENT)
}

/// GET /api/v1/projects/{id}/tasks/{taskId}/graph/chats/{chat_id}/mention-candidates
///
/// Returns three candidate groups for the @-mention dropdown in the chat
/// composer: agents that can be spawned, sessions reachable via outgoing edges
/// (can be sent to), and senders currently waiting for a reply from the caller
/// (can be replied to).
pub async fn mention_candidates(
    Path((id, task_id, chat_id)): Path<(String, String, String)>,
) -> Result<Json<MentionCandidatesResponse>, StatusCode> {
    let (_project, project_key) = common::find_project_by_id(&id)?;

    let pk = project_key.clone();
    let tid = task_id.clone();
    let cid = chat_id.clone();

    let result = tokio::task::spawn_blocking(move || build_mention_candidates(&pk, &tid, &cid))
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    result.map(Json).ok_or(StatusCode::NOT_FOUND)
}

fn build_mention_candidates(
    project_key: &str,
    task_id: &str,
    chat_id: &str,
) -> Option<MentionCandidatesResponse> {
    // Verify caller chat exists and belongs to this task — guards against
    // cross-task probes that would otherwise return another task's contacts.
    let chats = tasks::load_chat_sessions(project_key, task_id).ok()?;
    if !chats.iter().any(|c| c.id == chat_id) {
        return None;
    }

    let conn = database::connection();
    let outgoing_edges = graph_db::outgoing_for_session(&conn, chat_id).ok()?;
    let pending = graph_db::pending_replies_for(&conn, chat_id).ok()?;
    drop(conn);

    // Outgoing candidates = every other session in the same task (whether or
    // not an edge exists). The user's mental model is "any chat in the task
    // is mentionable"; the spec §6 send template instructs the AI to use
    // grove_agent_send, which will surface no_edge if missing — that's a
    // dispatch-time concern, not a discovery-time one. Edge-backed sessions
    // are listed first so they sort above the rest.
    let edge_ids: std::collections::HashSet<String> = outgoing_edges
        .iter()
        .map(|c| c.to_session_id.clone())
        .collect();

    let agents = skills::get_all_agents()
        .into_iter()
        .filter(|a| a.enabled)
        .map(|a| MentionAgent {
            name: a.id.clone(),
            display_name: a.display_name,
            icon_id: a.icon_id,
        })
        .collect();

    // Build chat lookup tables: id → (name, agent).
    let chat_meta: std::collections::HashMap<String, (String, String)> = chats
        .iter()
        .map(|c| (c.id.clone(), (c.title.clone(), c.agent.clone())))
        .collect();

    // Edge-backed first (in their existing edge order), then the remaining
    // same-task sessions (excluding caller and pending-reply senders, since
    // those already appear under their own group).
    let pending_ids: std::collections::HashSet<String> =
        pending.iter().map(|p| p.from_session.clone()).collect();

    let mut outgoing: Vec<MentionOutgoing> = outgoing_edges
        .into_iter()
        .map(|c| {
            let agent = chat_meta
                .get(&c.to_session_id)
                .map(|(_, a)| a.clone())
                .unwrap_or_default();
            MentionOutgoing {
                session_id: c.to_session_id,
                name: c.to_session_name,
                agent,
                duty: c.to_session_duty,
            }
        })
        .collect();

    for chat in &chats {
        if chat.id == chat_id || edge_ids.contains(&chat.id) || pending_ids.contains(&chat.id) {
            continue;
        }
        outgoing.push(MentionOutgoing {
            session_id: chat.id.clone(),
            name: chat.title.clone(),
            agent: chat.agent.clone(),
            duty: chat.duty.clone(),
        });
    }

    let make_excerpt = crate::agent_graph::pending_body_excerpt;
    let pending_replies = pending
        .into_iter()
        .map(|p| {
            let (name, agent) = chat_meta
                .get(&p.from_session)
                .cloned()
                .unwrap_or_else(|| (p.from_session.clone(), String::new()));
            MentionPendingReply {
                session_id: p.from_session,
                name,
                agent,
                msg_id: p.msg_id,
                body_preview: make_excerpt(&p.body),
            }
        })
        .collect();

    Some(MentionCandidatesResponse {
        agents,
        outgoing,
        pending_replies,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::database::{connection, test_lock};
    use crate::storage::set_grove_dir_override;
    use crate::storage::tasks::{add_chat_session, add_task, ChatSession, Task, TaskStatus};
    use crate::storage::workspace::{add_project_with_type, ProjectType};

    struct GroveDirGuard;
    impl Drop for GroveDirGuard {
        fn drop(&mut self) {
            set_grove_dir_override(None);
            let _ = connection();
        }
    }

    fn with_temp_home(test: impl FnOnce(&str, &str)) {
        let _lock = test_lock().blocking_lock();
        let temp = tempfile::tempdir().unwrap();
        let grove_path = temp.path().join(".grove");
        std::fs::create_dir_all(&grove_path).unwrap();
        set_grove_dir_override(Some(grove_path));
        let _guard = GroveDirGuard;

        let project_id = "proj-1";
        let task_id = "task-1";
        let project_path = temp.path().join("project-1");
        std::fs::create_dir_all(&project_path).unwrap();
        add_project_with_type(
            "Test Project",
            project_path.to_str().unwrap(),
            ProjectType::Studio,
        )
        .unwrap();

        let task = Task {
            id: task_id.to_string(),
            name: "Test Task".to_string(),
            branch: "feature/test".to_string(),
            target: "main".to_string(),
            worktree_path: "/tmp/worktree".to_string(),
            created_at: chrono::Utc::now(),
            updated_at: chrono::Utc::now(),
            status: TaskStatus::Active,
            multiplexer: "tmux".to_string(),
            session_name: String::new(),
            created_by: "test".to_string(),
            archived_at: None,
            initial_commit: None,
            code_additions: 0,
            code_deletions: 0,
            files_changed: 0,
            is_local: false,
        };
        add_task(project_id, task).unwrap();

        test(project_id, task_id);
    }

    #[test]
    fn empty_graph_returns_single_node() {
        with_temp_home(|project_id, task_id| {
            let chat = ChatSession {
                id: "chat-1".to_string(),
                title: "Chat 1".to_string(),
                agent: "claude".to_string(),
                acp_session_id: None,
                created_at: chrono::Utc::now(),
                duty: None,
            };
            add_chat_session(project_id, task_id, chat).unwrap();

            let resp = build_graph_response(project_id, task_id).unwrap();
            assert_eq!(resp.nodes.len(), 1);
            assert_eq!(resp.nodes[0].chat_id, "chat-1");
            assert_eq!(resp.nodes[0].status, "disconnected");
            assert_eq!(resp.nodes[0].pending_in, 0);
            assert_eq!(resp.nodes[0].pending_out, 0);
            assert!(resp.nodes[0].pending_messages.is_empty());
            assert!(resp.edges.is_empty());
        });
    }

    #[test]
    fn graph_with_edge_and_pending_message() {
        with_temp_home(|project_id, task_id| {
            let chat1 = ChatSession {
                id: "chat-1".to_string(),
                title: "Chat 1".to_string(),
                agent: "claude".to_string(),
                acp_session_id: None,
                created_at: chrono::Utc::now(),
                duty: Some("review".to_string()),
            };
            let chat2 = ChatSession {
                id: "chat-2".to_string(),
                title: "Chat 2".to_string(),
                agent: "codex".to_string(),
                acp_session_id: None,
                created_at: chrono::Utc::now(),
                duty: None,
            };
            add_chat_session(project_id, task_id, chat1).unwrap();
            add_chat_session(project_id, task_id, chat2).unwrap();

            let edge_id = {
                let conn = connection();
                let eid = graph_db::add_edge(
                    &conn,
                    project_id,
                    task_id,
                    "chat-1",
                    "chat-2",
                    Some("delegate"),
                )
                .unwrap();
                graph_db::insert_pending_message(
                    &conn,
                    "msg-1",
                    task_id,
                    "chat-1",
                    "chat-2",
                    "Hello, please review this.",
                )
                .unwrap();
                eid
            };

            let resp = build_graph_response(project_id, task_id).unwrap();
            assert_eq!(resp.nodes.len(), 2);
            assert_eq!(resp.edges.len(), 1);
            assert_eq!(resp.edges[0].edge_id, edge_id);
            assert_eq!(resp.edges[0].state, "blocked");
            assert_eq!(resp.edges[0].purpose.as_deref(), Some("delegate"));

            let sender = &resp.nodes[0];
            assert_eq!(sender.chat_id, "chat-1");
            assert_eq!(sender.pending_in, 0);
            assert_eq!(sender.pending_out, 1);
            assert_eq!(sender.pending_messages.len(), 1);
            assert_eq!(sender.pending_messages[0].from_name, "Chat 1");
            assert_eq!(sender.pending_messages[0].to_name, "Chat 2");
            assert!(sender.pending_messages[0].body_excerpt.contains("Hello"));

            let receiver = &resp.nodes[1];
            assert_eq!(receiver.chat_id, "chat-2");
            assert_eq!(receiver.pending_in, 1);
            assert_eq!(receiver.pending_out, 0);
            assert_eq!(receiver.pending_messages.len(), 1);

            let edge_pending = resp.edges[0].pending_message.as_ref().unwrap();
            assert_eq!(edge_pending.from_name, "Chat 1");
            assert_eq!(edge_pending.to_name, "Chat 2");
            assert_eq!(edge_pending.body_excerpt, "Hello, please review this.");
        });
    }

    #[test]
    fn add_edge_happy() {
        with_temp_home(|project_id, task_id| {
            let chat1 = ChatSession {
                id: "chat-a".to_string(),
                title: "Chat A".to_string(),
                agent: "claude".to_string(),
                acp_session_id: None,
                created_at: chrono::Utc::now(),
                duty: None,
            };
            let chat2 = ChatSession {
                id: "chat-b".to_string(),
                title: "Chat B".to_string(),
                agent: "codex".to_string(),
                acp_session_id: None,
                created_at: chrono::Utc::now(),
                duty: None,
            };
            add_chat_session("proj-1", task_id, chat1).unwrap();
            add_chat_session("proj-1", task_id, chat2).unwrap();

            let result =
                user_ops::user_add_edge(project_id, task_id, "chat-a", "chat-b", Some("delegate"));
            assert!(result.is_ok(), "add_edge should succeed: {:?}", result);
            let edge_id = result.unwrap();
            assert!(edge_id > 0);
        });
    }

    #[test]
    fn add_edge_rejects_cycle() {
        with_temp_home(|project_id, task_id| {
            for (id, name) in [("a", "A"), ("b", "B"), ("c", "C")] {
                let chat = ChatSession {
                    id: id.to_string(),
                    title: name.to_string(),
                    agent: "claude".to_string(),
                    acp_session_id: None,
                    created_at: chrono::Utc::now(),
                    duty: None,
                };
                add_chat_session("proj-1", task_id, chat).unwrap();
            }

            user_ops::user_add_edge(project_id, task_id, "a", "b", None).unwrap();
            user_ops::user_add_edge(project_id, task_id, "b", "c", None).unwrap();

            let err = user_ops::user_add_edge(project_id, task_id, "c", "a", None).unwrap_err();
            assert!(
                err.contains("cycle_would_form"),
                "expected cycle error, got: {}",
                err
            );
        });
    }

    #[test]
    fn update_edge_purpose_happy() {
        with_temp_home(|project_id, task_id| {
            let chat1 = ChatSession {
                id: "chat-x".to_string(),
                title: "X".to_string(),
                agent: "claude".to_string(),
                acp_session_id: None,
                created_at: chrono::Utc::now(),
                duty: None,
            };
            let chat2 = ChatSession {
                id: "chat-y".to_string(),
                title: "Y".to_string(),
                agent: "codex".to_string(),
                acp_session_id: None,
                created_at: chrono::Utc::now(),
                duty: None,
            };
            add_chat_session("proj-1", task_id, chat1).unwrap();
            add_chat_session("proj-1", task_id, chat2).unwrap();

            let edge_id =
                user_ops::user_add_edge(project_id, task_id, "chat-x", "chat-y", Some("initial"))
                    .unwrap();

            let conn = connection();
            graph_db::update_edge_purpose(&conn, edge_id, Some("updated")).unwrap();
            let edge = graph_db::get_edge(&conn, edge_id).unwrap().unwrap();
            assert_eq!(edge.purpose.as_deref(), Some("updated"));
        });
    }

    #[test]
    fn delete_edge_happy() {
        with_temp_home(|project_id, task_id| {
            let chat1 = ChatSession {
                id: "chat-d1".to_string(),
                title: "D1".to_string(),
                agent: "claude".to_string(),
                acp_session_id: None,
                created_at: chrono::Utc::now(),
                duty: None,
            };
            let chat2 = ChatSession {
                id: "chat-d2".to_string(),
                title: "D2".to_string(),
                agent: "codex".to_string(),
                acp_session_id: None,
                created_at: chrono::Utc::now(),
                duty: None,
            };
            add_chat_session("proj-1", task_id, chat1).unwrap();
            add_chat_session("proj-1", task_id, chat2).unwrap();

            let edge_id =
                user_ops::user_add_edge(project_id, task_id, "chat-d1", "chat-d2", None).unwrap();

            let conn = connection();
            graph_db::delete_edge(&conn, edge_id).unwrap();
            assert!(graph_db::get_edge(&conn, edge_id).unwrap().is_none());
        });
    }

    #[test]
    fn mention_candidates_happy() {
        with_temp_home(|project_id, task_id| {
            let chat_a = ChatSession {
                id: "chat-a".to_string(),
                title: "Caller".to_string(),
                agent: "claude".to_string(),
                acp_session_id: None,
                created_at: chrono::Utc::now(),
                duty: None,
            };
            let chat_b = ChatSession {
                id: "chat-b".to_string(),
                title: "Frontend-Tester".to_string(),
                agent: "codex".to_string(),
                acp_session_id: None,
                created_at: chrono::Utc::now(),
                duty: Some("frontend tests".to_string()),
            };
            let chat_c = ChatSession {
                id: "chat-c".to_string(),
                title: "Backend-Designer".to_string(),
                agent: "codex".to_string(),
                acp_session_id: None,
                created_at: chrono::Utc::now(),
                duty: None,
            };
            add_chat_session(project_id, task_id, chat_a).unwrap();
            add_chat_session(project_id, task_id, chat_b).unwrap();
            add_chat_session(project_id, task_id, chat_c).unwrap();

            // chat-a → chat-b (outgoing edge)
            user_ops::user_add_edge(project_id, task_id, "chat-a", "chat-b", Some("delegate"))
                .unwrap();
            // chat-c → chat-a edge so chat-c can have an in-flight message
            // pending caller's reply.
            user_ops::user_add_edge(project_id, task_id, "chat-c", "chat-a", None).unwrap();
            {
                let conn = connection();
                graph_db::insert_pending_message(
                    &conn,
                    "msg-789",
                    task_id,
                    "chat-c",
                    "chat-a",
                    "Need design feedback",
                )
                .unwrap();
            }

            let resp = build_mention_candidates(project_id, task_id, "chat-a").unwrap();

            // outgoing: chat-b
            assert_eq!(resp.outgoing.len(), 1);
            assert_eq!(resp.outgoing[0].session_id, "chat-b");
            assert_eq!(resp.outgoing[0].name, "Frontend-Tester");
            assert_eq!(resp.outgoing[0].agent, "codex");
            assert_eq!(resp.outgoing[0].duty.as_deref(), Some("frontend tests"));

            // pending_replies: from chat-c
            assert_eq!(resp.pending_replies.len(), 1);
            assert_eq!(resp.pending_replies[0].session_id, "chat-c");
            assert_eq!(resp.pending_replies[0].name, "Backend-Designer");
            assert_eq!(resp.pending_replies[0].agent, "codex");
            assert_eq!(resp.pending_replies[0].msg_id, "msg-789");
            assert!(resp.pending_replies[0]
                .body_preview
                .contains("Need design feedback"));

            // agents list: at least one builtin (claude/codex) is always present
            assert!(!resp.agents.is_empty());
        });
    }

    #[test]
    fn mention_candidates_includes_edgeless_same_task_sessions() {
        with_temp_home(|project_id, task_id| {
            // caller + two siblings, no edges anywhere — siblings should
            // still surface so the user can @-mention by name.
            for (id, name, agent) in [
                ("caller", "Caller", "claude"),
                ("sib-1", "Sibling One", "codex"),
                ("sib-2", "Sibling Two", "gemini"),
            ] {
                add_chat_session(
                    project_id,
                    task_id,
                    ChatSession {
                        id: id.to_string(),
                        title: name.to_string(),
                        agent: agent.to_string(),
                        acp_session_id: None,
                        created_at: chrono::Utc::now(),
                        duty: None,
                    },
                )
                .unwrap();
            }

            let resp = build_mention_candidates(project_id, task_id, "caller").unwrap();
            // Caller excluded; both siblings present with their agent kind.
            let names: std::collections::HashSet<_> =
                resp.outgoing.iter().map(|o| o.name.clone()).collect();
            assert_eq!(names.len(), 2);
            assert!(names.contains("Sibling One"));
            assert!(names.contains("Sibling Two"));
            let by_name: std::collections::HashMap<_, _> = resp
                .outgoing
                .iter()
                .map(|o| (o.name.clone(), o.agent.clone()))
                .collect();
            assert_eq!(
                by_name.get("Sibling One").map(String::as_str),
                Some("codex")
            );
            assert_eq!(
                by_name.get("Sibling Two").map(String::as_str),
                Some("gemini")
            );
        });
    }

    #[test]
    fn mention_candidates_empty_graph() {
        with_temp_home(|project_id, task_id| {
            let chat = ChatSession {
                id: "chat-solo".to_string(),
                title: "Solo".to_string(),
                agent: "claude".to_string(),
                acp_session_id: None,
                created_at: chrono::Utc::now(),
                duty: None,
            };
            add_chat_session(project_id, task_id, chat).unwrap();

            let resp = build_mention_candidates(project_id, task_id, "chat-solo").unwrap();
            assert!(resp.outgoing.is_empty());
            assert!(resp.pending_replies.is_empty());
            assert!(!resp.agents.is_empty());
        });
    }

    #[test]
    fn mention_candidates_rejects_cross_task_chat() {
        with_temp_home(|project_id, task_id| {
            // Add a different task with a chat — querying that chat under
            // the wrong task_id must return None instead of leaking data.
            let other_task = Task {
                id: "task-2".to_string(),
                name: "Other".to_string(),
                branch: "feature/other".to_string(),
                target: "main".to_string(),
                worktree_path: "/tmp/other".to_string(),
                created_at: chrono::Utc::now(),
                updated_at: chrono::Utc::now(),
                status: TaskStatus::Active,
                multiplexer: "tmux".to_string(),
                session_name: String::new(),
                created_by: "test".to_string(),
                archived_at: None,
                initial_commit: None,
                code_additions: 0,
                code_deletions: 0,
                files_changed: 0,
                is_local: false,
            };
            add_task(project_id, other_task).unwrap();

            let chat_in_other = ChatSession {
                id: "chat-other".to_string(),
                title: "Other".to_string(),
                agent: "claude".to_string(),
                acp_session_id: None,
                created_at: chrono::Utc::now(),
                duty: None,
            };
            add_chat_session(project_id, "task-2", chat_in_other).unwrap();

            // Querying chat-other under task_id (not task-2) must return None.
            assert!(build_mention_candidates(project_id, task_id, "chat-other").is_none());
        });
    }

    #[test]
    fn graph_error_status_codes() {
        let (status, resp) = graph_error("name_taken", "Name taken");
        assert_eq!(status, StatusCode::CONFLICT);
        assert_eq!(resp.code, "name_taken");

        let (status, _) = graph_error("cycle_would_form", "Cycle");
        assert_eq!(status, StatusCode::BAD_REQUEST);

        let (status, _) = graph_error("target_not_found", "Not found");
        assert_eq!(status, StatusCode::NOT_FOUND);

        let (status, _) = graph_error("internal_error", "Oops");
        assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
    }
}

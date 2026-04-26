//! Task agent graph handlers

use axum::{extract::Path, http::StatusCode, Json};

use crate::acp;
use crate::api::handlers::common;
use crate::storage::{agent_graph as graph_db, database, tasks};

use super::types::*;

fn build_graph_response(project_key: &str, task_id: &str) -> Option<GraphResponse> {
    let chats = tasks::load_chat_sessions(project_key, task_id).ok()?;
    let edges = {
        let conn = database::connection();
        graph_db::list_edges_for_task(&conn, task_id).ok()?
    };
    let pending_messages = {
        let conn = database::connection();
        graph_db::list_pending_for_task(&conn, task_id).ok()?
    };
    let pending_pairs: std::collections::HashSet<(String, String)> = pending_messages
        .iter()
        .map(|p| (p.from_session.clone(), p.to_session.clone()))
        .collect();

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

        graph_edges.push(GraphEdge {
            edge_id: edge.edge_id,
            from: edge.from_session.clone(),
            to: edge.to_session.clone(),
            purpose: edge.purpose.clone(),
            state: state.to_string(),
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
                let eid = graph_db::add_edge(&conn, task_id, "chat-1", "chat-2", Some("delegate"))
                    .unwrap();
                graph_db::insert_pending_message(
                    &conn, "msg-1", task_id, "chat-1", "chat-2", "Hello",
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
        });
    }
}

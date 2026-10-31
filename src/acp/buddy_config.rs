//! Apply Buddy preferences using only the live Agent's advertised setters.
use super::*;

impl AcpSessionHandle {
    /// Include every acknowledged option, including booleans, so failed
    /// multi-option changes can restore more than legacy model/mode fields.
    pub(crate) fn snapshot_buddy_config(&self) -> QueuedConfig {
        let mut snapshot = self.snapshot_config();
        for option in self.current_config_options.lock().unwrap().iter() {
            let value = match &option.kind {
                acp::SessionConfigKind::Select(value) => {
                    ConfigOptionValue::Select(value.current_value.to_string())
                }
                acp::SessionConfigKind::Boolean(value) => {
                    ConfigOptionValue::Boolean(value.current_value)
                }
                _ => continue,
            };
            snapshot.config_options.insert(option.id.to_string(), value);
        }
        snapshot
    }

    pub(crate) async fn apply_buddy_preferences(
        &self,
        persona: &crate::storage::custom_agent::CustomAgent,
    ) -> crate::error::Result<()> {
        let _activity = self.begin_activity()?;
        let before = self.snapshot_buddy_config();
        let mut desired = persona
            .agent_config
            .queued_config()
            .unwrap_or_else(|| QueuedConfig {
                model: persona.model.clone(),
                mode: persona.mode.clone(),
                thought_level: persona.effort.clone(),
                thought_level_config_id: before.thought_level_config_id.clone(),
                config_options: Default::default(),
            });
        if let Some(model) = desired.model.take() {
            let id = self
                .model_config_id
                .lock()
                .unwrap()
                .clone()
                .ok_or_else(|| {
                    crate::error::GroveError::invalid_data("Agent has no model config option")
                })?;
            desired
                .config_options
                .insert(id, ConfigOptionValue::Select(model));
        }
        if let Some(effort) = desired.thought_level.take() {
            let id = desired.thought_level_config_id.clone().ok_or_else(|| {
                crate::error::GroveError::invalid_data("Agent has no effort config option")
            })?;
            desired
                .config_options
                .insert(id, ConfigOptionValue::Select(effort));
        }
        let options = self.current_config_options.lock().unwrap().clone();
        for (id, value) in &desired.config_options {
            if !options.iter().any(|option| {
                option.id.to_string() == *id
                    && crate::agent_config::config_option_accepts(option, value)
            }) {
                return Err(crate::error::GroveError::invalid_data(format!(
                    "Unsupported Agent config option/value: {id}"
                )));
            }
        }
        if let Err(error) = self.apply_buddy_config_values(&desired).await {
            if let Err(rollback) = self.apply_buddy_config_values(&before).await {
                return Err(crate::error::GroveError::storage(format!(
                    "Configuration failed: {error}; restoring prior settings failed: {rollback}"
                )));
            }
            return Err(error);
        }
        Ok(())
    }

    async fn apply_buddy_config_values(&self, config: &QueuedConfig) -> crate::error::Result<()> {
        if let Some(mode) = &config.mode {
            if self.current_mode_id.lock().unwrap().as_ref() != Some(mode) {
                self.set_mode(mode.clone()).await?;
            }
        }
        let options = self.current_config_options.lock().unwrap().clone();
        for option in options {
            let id = option.id.to_string();
            if let Some(value) = config.config_options.get(&id) {
                if !crate::agent_config::config_option_has_current_value(&option, value) {
                    self.set_config_option(id, value.clone()).await?;
                }
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::{buddies::test_support::Store, database};

    #[tokio::test]
    async fn buddy_snapshot_retains_select_and_boolean_values_for_rollback() {
        let _lock = database::test_lock().lock().await;
        let _store = Store::new();
        let (handle, _, _guard) =
            new_handle_for_test("buddy-config-snapshot", "project", "task", "chat");
        *handle.current_config_options.lock().unwrap() = serde_json::from_value(serde_json::json!([
            {"id":"model", "name":"Model", "type":"select", "currentValue":"a", "options":[{"value":"a","name":"A"}]},
            {"id":"thinking", "name":"Thinking", "type":"boolean", "currentValue":true}
        ])).unwrap();
        let snapshot = handle.snapshot_buddy_config();
        assert_eq!(
            snapshot.config_options.get("model"),
            Some(&ConfigOptionValue::Select("a".into()))
        );
        assert_eq!(
            snapshot.config_options.get("thinking"),
            Some(&ConfigOptionValue::Boolean(true))
        );
    }

    #[tokio::test]
    async fn buddy_mcp_uses_its_own_server_and_stdio_bridge_route() {
        let _lock = database::test_lock().lock().await;
        let _store = Store::new();
        let env = HashMap::from([
            ("GROVE_MCP_TOKEN".into(), "buddy-token".into()),
            ("GROVE_MCP_PORT".into(), "1234".into()),
        ]);
        let extra = [LoopbackMcpServer {
            name: "grove_buddy".into(),
            url: "http://127.0.0.1:1234/buddy-mcp/buddy-token".into(),
            route: "buddy-mcp".into(),
            session_instruction: None,
        }];
        for http in [true, false] {
            let servers = build_mcp_servers(
                &env,
                Some("buddy-token"),
                http,
                &extra,
                McpServerPolicy::Buddy,
                &Mutex::default(),
            )
            .await
            .unwrap();
            let value = serde_json::to_value(servers).unwrap();
            let servers = value.as_array().unwrap();
            assert_eq!(servers.len(), 1);
            assert_eq!(servers[0]["name"], "grove_buddy");
            if http {
                assert_eq!(servers[0]["url"], extra[0].url);
            } else {
                assert_eq!(
                    servers[0]["args"],
                    serde_json::json!(["mcp-bridge", "--route", "buddy-mcp"])
                );
                assert!(servers[0]["env"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(
                        |item| item["name"] == "GROVE_MCP_TOKEN" && item["value"] == "buddy-token"
                    ));
            }
        }
    }
}

#[cfg(test)]
mod concurrency_tests {
    use super::*;
    use crate::storage::{
        buddies::test_support::{seed_buddy, Store},
        database, tasks,
    };

    #[tokio::test]
    async fn switch_rejects_thread_owned_startup_without_a_registered_handle() {
        let _lock = database::test_lock().lock().await;
        let _store = Store::new();
        let buddy = seed_buddy(&database::connection(), "pending-start");
        database::connection().execute("INSERT INTO installed_agents(id,installations,selected_install_method,created_at,updated_at) VALUES ('buddy-review-agent','[]','external','now','now')", []).unwrap();
        let chat = buddy.active_session_id.as_deref().unwrap();
        let key = format!("{}:_local:{chat}", buddy.project_hash);
        STARTING_SESSIONS.lock().unwrap().insert(key.clone());
        let result =
            crate::buddy::switch_agent(&buddy.id, "buddy-review-agent", Default::default()).await;
        STARTING_SESSIONS.lock().unwrap().remove(&key);
        assert_eq!(result.unwrap_err().storage_tag(), Some("buddy_busy"));
        assert_eq!(
            crate::buddy::get(&buddy.id).unwrap().active_session_id,
            buddy.active_session_id
        );
        assert!(
            crate::storage::buddies::get_segment(&database::connection(), chat)
                .unwrap()
                .unwrap()
                .ended_at
                .is_none()
        );
    }

    #[test]
    fn late_routine_cancel_only_matches_its_own_prompt_including_compact_turns() {
        let command = AcpCommand::CancelPrompts(vec!["automation:run".into()]);
        assert!(!command.cancels_prompt(&["human-next".into()]));
        assert!(command.cancels_prompt(&["human-before".into(), "automation:run".into()]));
        assert!(!command.cancels_prompt(&[]));
    }

    #[tokio::test]
    async fn routine_cancel_during_startup_prevents_later_admission() {
        let _lock = database::test_lock().lock().await;
        let _store = Store::new();
        let buddy = seed_buddy(&database::connection(), "routine-cancel");
        let routine = crate::buddy::routines::save(
            &buddy,
            None,
            crate::buddy::routines::RoutineInput {
                name: "Review".into(),
                prompt: "do not deliver after cancellation".into(),
                schedule_cron: "0 9 * * *".into(),
                enabled: true,
                event_triggers: Vec::new(),
            },
        )
        .unwrap();
        let chat = buddy.active_session_id.as_deref().unwrap();
        let key = format!("{}:_local:{chat}", buddy.project_hash);
        let (handle, mut updates, _guard) =
            new_handle_for_test(&key, &buddy.project_hash, tasks::LOCAL_TASK_ID, chat);
        handle.readiness.send_replace(SessionReadiness::Starting);
        let task_routine = routine.clone();
        let task =
            tokio::spawn(
                async move { crate::automation::executor::run(&task_routine, "manual").await },
            );
        let run = tokio::time::timeout(std::time::Duration::from_secs(2), async {
            loop {
                if let Some(run) = crate::storage::automations::list_runs(&routine.id, 1)
                    .unwrap()
                    .pop()
                {
                    break run;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        let _ = crate::api::handlers::automations::cancel_run(axum::extract::Path((
            buddy.project_hash.clone(),
            routine.id.clone(),
            run.id.clone(),
        )))
        .await
        .unwrap();
        handle.readiness.send_replace(SessionReadiness::Ready);
        let result = task.await.unwrap();
        assert_eq!(result.status, "cancelled");
        assert_eq!(
            crate::storage::automations::get_run(&run.id)
                .unwrap()
                .unwrap()
                .status,
            "cancelled"
        );
        while let Ok(update) = updates.try_recv() {
            assert!(!matches!(update, AcpUpdate::UserMessage { .. }));
        }
        assert!(handle.get_queue().is_empty());
    }

    #[tokio::test]
    async fn deleted_cancelled_routine_cannot_resume_after_startup() {
        let _lock = database::test_lock().lock().await;
        let _store = Store::new();
        let buddy = seed_buddy(&database::connection(), "routine-cancel-deleted");
        let routine = crate::buddy::routines::save(
            &buddy,
            None,
            crate::buddy::routines::RoutineInput {
                name: "Review".into(),
                prompt: "do not deliver after cancellation".into(),
                schedule_cron: "0 9 * * *".into(),
                enabled: true,
                event_triggers: Vec::new(),
            },
        )
        .unwrap();
        let chat = buddy.active_session_id.as_deref().unwrap();
        let key = format!("{}:_local:{chat}", buddy.project_hash);
        let (handle, mut updates, _guard) =
            new_handle_for_test(&key, &buddy.project_hash, tasks::LOCAL_TASK_ID, chat);
        handle.readiness.send_replace(SessionReadiness::Starting);
        let task_routine = routine.clone();
        let task =
            tokio::spawn(
                async move { crate::automation::executor::run(&task_routine, "manual").await },
            );
        let run = tokio::time::timeout(std::time::Duration::from_secs(2), async {
            loop {
                if let Some(run) = crate::storage::automations::list_runs(&routine.id, 1)
                    .unwrap()
                    .pop()
                {
                    break run;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        let _ = crate::api::handlers::automations::cancel_run(axum::extract::Path((
            buddy.project_hash.clone(),
            routine.id.clone(),
            run.id.clone(),
        )))
        .await
        .unwrap();
        assert!(crate::storage::automations::delete_finished_run(&routine.id, &run.id).unwrap());
        handle.readiness.send_replace(SessionReadiness::Ready);
        let result = task.await.unwrap();
        assert_eq!(result.status, "failed");
        assert_eq!(result.error.as_deref(), Some("Run no longer exists"));
        assert!(crate::storage::automations::get_run(&run.id)
            .unwrap()
            .is_none());
        while let Ok(update) = updates.try_recv() {
            assert!(!matches!(update, AcpUpdate::UserMessage { .. }));
        }
        assert!(handle.get_queue().is_empty());
    }

    #[tokio::test]
    async fn queue_admission_drains_when_prior_turn_finished_before_insertion() {
        let _lock = database::test_lock().lock().await;
        let _store = Store::new();
        let (handle, mut updates, _guard) =
            new_handle_for_test("review-queue-race", "project", "task", "chat");
        // The caller observed busy, but the old turn has finished before the
        // async middleware returns and submit_queued_message inserts its input.
        let message = QueuedMessage::new("follow up".into(), Vec::new(), None, false, None);
        let id = message.id.clone();
        handle.submit_queued_message(message).await.unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(2), async {
            loop {
                if let AcpUpdate::UserMessage {
                    client_message_id, ..
                } = updates.recv().await.unwrap()
                {
                    assert_eq!(client_message_id.as_deref(), Some(id.as_str()));
                    break;
                }
            }
        })
        .await
        .unwrap();
        assert!(handle.get_queue().is_empty());
    }

    #[tokio::test]
    async fn permission_response_cannot_consume_a_replaced_request() {
        let _lock = database::test_lock().lock().await;
        let _store = Store::new();
        let (handle, _, _guard) =
            new_handle_for_test("review-permission", "project", "task", "chat");
        let (tx, mut rx) = tokio::sync::oneshot::channel();
        *handle.pending_permission.lock().unwrap() = Some(("new-request".into(), tx));
        assert!(!handle.respond_permission_for("old-request", "allow".into()));
        assert!(matches!(
            rx.try_recv(),
            Err(tokio::sync::oneshot::error::TryRecvError::Empty)
        ));
        assert!(handle.respond_permission_for("new-request", "allow".into()));
        assert_eq!(rx.await.unwrap(), "allow");
    }
    #[tokio::test]
    async fn slow_buddy_startup_does_not_block_delegate_events_or_deliver_stale_waiting() {
        use crate::storage::buddies::{self as db, test_support::delegation, DelegationStatus};
        let _lock = database::test_lock().lock().await;
        let _store = Store::new();
        let buddy = seed_buddy(&database::connection(), "slow-notify");
        let d = delegation(&database::connection(), &buddy, "slow-notify-work");
        db::insert_delegation(&database::connection(), &d).unwrap();
        let key = format!(
            "{}:{}:{}",
            d.target_project, d.target_task, d.target_session
        );
        let (target, _, _target_guard) =
            new_handle_for_test(&key, &d.target_project, &d.target_task, &d.target_session);
        target
            .is_busy
            .store(true, std::sync::atomic::Ordering::Release);
        let chat = buddy.active_session_id.as_deref().unwrap();
        let key = format!("{}:_local:{chat}", buddy.project_hash);
        let (owner, _, _owner_guard) =
            new_handle_for_test(&key, &buddy.project_hash, tasks::LOCAL_TASK_ID, chat);
        owner.readiness.send_replace(SessionReadiness::Starting);
        owner
            .is_busy
            .store(true, std::sync::atomic::Ordering::Release);
        let id = crate::buddy::delegations::send_round(&buddy, &d, "work", None)
            .await
            .unwrap();
        target.emit(AcpUpdate::PromptStarted {
            message_ids: vec![id],
        });
        target.emit(AcpUpdate::AskForm {
            form_id: "form".into(),
            definition: serde_json::from_value(
                serde_json::json!({"title":"Question","questions":[]}),
            )
            .unwrap(),
        });
        tokio::task::yield_now().await;
        target.emit(
            serde_json::from_value(serde_json::json!({"type":"user_message","text":"answer"}))
                .unwrap(),
        );
        // More updates than the broadcast channel capacity, while notification
        // is blocked on readiness. The observer must keep consuming them.
        for _ in 0..400 {
            target.emit(AcpUpdate::MessageChunk {
                message_id: None,
                text: "x".into(),
            });
            tokio::task::yield_now().await;
        }
        target.emit(AcpUpdate::Complete {
            stop_reason: "end_turn".into(),
            usage: None,
            start_ts: None,
            end_ts: None,
            cost: None,
        });
        tokio::time::timeout(std::time::Duration::from_secs(2), async {
            while crate::buddy::delegations::get(&buddy.id, &d.id)
                .unwrap()
                .status
                != DelegationStatus::Done
            {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert_eq!(
            crate::buddy::delegations::get(&buddy.id, &d.id)
                .unwrap()
                .last_result
                .unwrap(),
            "x".repeat(400)
        );
        assert!(owner.get_queue().is_empty());
        owner.readiness.send_replace(SessionReadiness::Ready);
        tokio::time::timeout(std::time::Duration::from_secs(2), async {
            while owner.get_queue().is_empty() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        tokio::task::yield_now().await;
        assert_eq!(owner.get_queue().len(), 1);
        assert!(owner.get_queue()[0].text.contains("\"status\":\"done\""));
        owner.clear_queue();
        owner.readiness.send_replace(SessionReadiness::Starting);
        let id = crate::buddy::delegations::send_round(&buddy, &d, "more work", None)
            .await
            .unwrap();
        target.emit(AcpUpdate::PromptStarted {
            message_ids: vec![id],
        });
        target.emit(AcpUpdate::AskForm {
            form_id: "cancel-form".into(),
            definition: serde_json::from_value(
                serde_json::json!({"title":"Question","questions":[]}),
            )
            .unwrap(),
        });
        tokio::time::timeout(std::time::Duration::from_secs(2), async {
            while crate::buddy::delegations::get(&buddy.id, &d.id)
                .unwrap()
                .status
                != DelegationStatus::Waiting
            {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        crate::buddy::delegations::cancel(&buddy.id, &d.id)
            .await
            .unwrap();
        owner.readiness.send_replace(SessionReadiness::Ready);
        for _ in 0..10 {
            tokio::task::yield_now().await;
        }
        assert!(owner.get_queue().is_empty());
        assert_eq!(
            crate::buddy::delegations::get(&buddy.id, &d.id)
                .unwrap()
                .status,
            DelegationStatus::Cancelled
        );
    }
    #[tokio::test]
    async fn switch_waits_for_turn_finalization_after_busy_becomes_false() {
        let _lock = database::test_lock().lock().await;
        let _store = Store::new();
        let buddy = seed_buddy(&database::connection(), "finalizing-turn");
        let chat = buddy.active_session_id.as_deref().unwrap();
        let key = format!("{}:_local:{chat}", buddy.project_hash);
        let (handle, _, _guard) =
            new_handle_for_test(&key, &buddy.project_hash, tasks::LOCAL_TASK_ID, chat);
        handle.emit(AcpUpdate::PromptStarted {
            message_ids: vec!["turn".into()],
        });
        handle.emit(AcpUpdate::Busy { value: false });
        assert!(!handle.try_retire_for_buddy_switch());
        handle.emit(AcpUpdate::PromptFailed {
            message_ids: vec!["unrelated-queued-input".into()],
            message: "middleware rejected".into(),
        });
        assert!(!handle.try_retire_for_buddy_switch());

        handle.emit(AcpUpdate::Complete {
            stop_reason: "end_turn".into(),
            usage: None,
            start_ts: None,
            end_ts: None,
            cost: None,
        });
        handle.emit(AcpUpdate::PromptCompleted {
            message_ids: vec!["turn".into()],
            stop_reason: "end_turn".into(),
        });
        assert!(handle.try_retire_for_buddy_switch());
        let path = crate::storage::chat_history::history_file_path(
            &buddy.project_hash,
            tasks::LOCAL_TASK_ID,
            chat,
        );
        let before = std::fs::read(&path).unwrap();
        crate::buddy::switch_on(
            &database::connection(),
            &buddy,
            "codex-acp",
            Default::default(),
        )
        .unwrap();
        handle.emit(AcpUpdate::MessageChunk {
            message_id: None,
            text: "late event".into(),
        });
        assert_eq!(std::fs::read(path).unwrap(), before);
    }
}

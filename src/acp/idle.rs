//! Idle collection is decided only between commands, never during an Agent RPC.
use super::*;
use std::time::{Duration, Instant};

pub(super) const IDLE_TIMEOUT: Duration = Duration::from_secs(30 * 60);
pub(super) const IDLE_CHECK_INTERVAL: Duration = Duration::from_secs(60);

#[derive(Debug)]
pub(super) struct IdleState {
    last_activity: Instant,
    observers: usize,
    operations: usize,
    retiring: bool,
    can_restore_session: bool,
}

impl Default for IdleState {
    fn default() -> Self {
        Self {
            last_activity: Instant::now(),
            observers: 0,
            operations: 0,
            retiring: false,
            can_restore_session: false,
        }
    }
}

/// Owns admission until the WS detaches or an asynchronous operation finishes.
/// Sharing the gate with retirement prevents a check-then-kill race.
pub(crate) struct ActivityGuard {
    state: Arc<Mutex<IdleState>>,
    observer: bool,
}

impl Drop for ActivityGuard {
    fn drop(&mut self) {
        let mut state = self.state.lock().unwrap();
        if self.observer {
            state.observers -= 1;
        } else {
            state.operations -= 1;
            state.last_activity = Instant::now();
        }
    }
}

impl AcpSessionHandle {
    /// Unknown capabilities are deliberately ineligible: local chat history
    /// alone cannot restore the Agent's in-memory conversation after exit.
    pub(super) fn set_session_restore_capabilities(&self, load: bool, resume: bool) {
        self.idle.lock().unwrap().can_restore_session = load || resume;
    }

    fn reserve_activity(&self, observer: bool) -> crate::error::Result<ActivityGuard> {
        let mut state = self.idle.lock().unwrap();
        if state.retiring {
            return Err(crate::error::GroveError::Session(
                "ACP session is retiring".into(),
            ));
        }
        if observer {
            state.observers += 1;
        } else {
            state.operations += 1;
            state.last_activity = Instant::now();
        }
        Ok(ActivityGuard {
            state: self.idle.clone(),
            observer,
        })
    }

    pub(crate) fn attach_observer(&self) -> crate::error::Result<ActivityGuard> {
        self.reserve_activity(true)
    }

    pub(crate) fn begin_activity(&self) -> crate::error::Result<ActivityGuard> {
        self.reserve_activity(false)
    }

    pub(crate) fn is_retiring(&self) -> bool {
        self.idle.lock().unwrap().retiring
    }

    pub(crate) fn record_activity(&self) {
        self.idle.lock().unwrap().last_activity = Instant::now();
    }

    /// Called by the idle branch of the outer command loop. All async work
    /// admissions hold an ActivityGuard before changing queue/busy state.
    /// Try-lock other state: event producers may hold it while recording I/O.
    fn try_retire_idle(&self, now: Instant) -> bool {
        let mut idle = self.idle.lock().unwrap();
        if !idle.can_restore_session
            || idle.retiring
            || idle.observers != 0
            || idle.operations != 0
            || now.saturating_duration_since(idle.last_activity) < IDLE_TIMEOUT
            || self.is_busy.load(std::sync::atomic::Ordering::Acquire)
            || self
                .pending_queue
                .try_lock()
                .map_or(true, |q| !q.is_empty())
            || self
                .pending_permission
                .try_lock()
                .map_or(true, |p| p.is_some())
            || self
                .pending_elicitation
                .try_lock()
                .map_or(true, |p| p.is_some())
            || self
                .active_url_elicitations
                .try_lock()
                .map_or(true, |p| !p.is_empty())
            || self.pending_auth.try_lock().map_or(true, |p| p.is_some())
            || self
                .terminal_auth
                .try_lock()
                .map_or(true, |p| p.active.is_some() || p.reconnecting)
            || self
                .pending_auth_retry
                .try_lock()
                .map_or(true, |p| p.is_some())
            || self
                .terminal_kill_tx
                .try_lock()
                .map_or(true, |p| p.is_some())
            || self
                .active_tool_calls
                .try_lock()
                .map_or(true, |p| !p.is_empty())
            || self
                .subagents
                .try_lock()
                .map_or(true, |s| s.has_active_children())
        {
            return false;
        }
        idle.retiring = true;
        true
    }

    pub(super) async fn next_command(
        &self,
        commands: &mut mpsc::Receiver<AcpCommand>,
    ) -> Option<AcpCommand> {
        self.next_command_with_interval(commands, IDLE_CHECK_INTERVAL)
            .await
    }

    async fn next_command_with_interval(
        &self,
        commands: &mut mpsc::Receiver<AcpCommand>,
        interval: Duration,
    ) -> Option<AcpCommand> {
        loop {
            tokio::select! {
                biased;
                command = commands.recv() => {
                    if command.is_some() { self.record_activity(); }
                    return command;
                }
                _ = tokio::time::sleep(interval) => {
                    // The producer guard covers admissions racing with this
                    // branch; buffered commands take priority above.
                    if commands.is_empty() && self.try_retire_idle(Instant::now()) {
                        eprintln!("[ACP] Releasing idle runtime: {}", self.key);
                        return None;
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> (
        Arc<AcpSessionHandle>,
        broadcast::Receiver<AcpUpdate>,
        TestSessionGuard,
    ) {
        let fixture = unconfigured_fixture();
        fixture.0.set_session_restore_capabilities(true, false);
        fixture
    }

    fn unconfigured_fixture() -> (
        Arc<AcpSessionHandle>,
        broadcast::Receiver<AcpUpdate>,
        TestSessionGuard,
    ) {
        let id = uuid::Uuid::new_v4().to_string();
        new_handle_for_test(&format!("idle:task:{id}"), "idle", "task", &id)
    }

    fn age(handle: &AcpSessionHandle) {
        handle.idle.lock().unwrap().last_activity = Instant::now() - IDLE_TIMEOUT;
    }

    #[tokio::test]
    async fn unknown_or_unsupported_restore_capabilities_keep_runtime_alive() {
        for capabilities in [None, Some((false, false))] {
            let (handle, _updates, _guard) = unconfigured_fixture();
            if let Some((load, resume)) = capabilities {
                handle.set_session_restore_capabilities(load, resume);
            }
            age(&handle);
            assert!(!handle.try_retire_idle(Instant::now()));
            let (tx, mut rx) = mpsc::channel(1);
            let next = handle.next_command_with_interval(&mut rx, Duration::from_millis(1));
            tokio::pin!(next);
            // Several collector ticks must leave the command loop usable.
            assert!(tokio::time::timeout(Duration::from_millis(10), &mut next)
                .await
                .is_err());
            tx.send(AcpCommand::Cancel).await.unwrap();
            assert!(matches!(next.await, Some(AcpCommand::Cancel)));
            assert!(!handle.is_retiring());
        }
    }

    #[tokio::test]
    async fn either_load_or_resume_allows_idle_collection() {
        for (load, resume) in [(true, false), (false, true), (true, true)] {
            let (handle, _updates, _guard) = unconfigured_fixture();
            handle.set_session_restore_capabilities(load, resume);
            age(&handle);
            assert!(handle.try_retire_idle(Instant::now()));
        }
    }

    #[tokio::test]
    async fn shared_message_admission_protects_preparation_and_queue_handoff() {
        let (handle, _updates, _guard) = fixture();
        let chat = handle.chat_id.as_deref().unwrap();
        age(&handle);
        let (target, activity) =
            crate::agent_graph::tools::ensure_target_handle("idle", "task", chat)
                .await
                .unwrap();
        assert!(Arc::ptr_eq(&handle, &target));
        // Reproduce the old lookup-to-submit window, including arbitrarily
        // slow config/attachment preparation before a busy claim is made.
        age(&handle);
        assert!(!handle.try_retire_idle(Instant::now()));
        target
            .submit_queued_message(QueuedMessage::new(
                "accepted once".into(),
                vec![],
                None,
                false,
                None,
            ))
            .await
            .unwrap();
        drop(activity);
        age(&handle);
        assert!(!handle.try_retire_idle(Instant::now()));
        assert_eq!(handle.get_queue().len(), 1);
        handle.pending_queue.lock().unwrap().clear();
        assert!(handle.try_retire_idle(Instant::now()));
    }

    #[tokio::test]
    async fn abandoned_message_preparation_releases_shared_admission() {
        let (handle, _updates, _guard) = fixture();
        let chat = handle.chat_id.as_deref().unwrap();
        let prepared = crate::agent_graph::tools::ensure_target_handle("idle", "task", chat)
            .await
            .unwrap();
        age(&handle);
        assert!(!handle.try_retire_idle(Instant::now()));
        // A validation failure or cancelled caller drops the guard without
        // submitting anything. It must not pin the runtime indefinitely.
        drop(prepared);
        assert!(!handle.try_retire_idle(Instant::now()));
        age(&handle);
        assert!(handle.try_retire_idle(Instant::now()));
    }

    #[tokio::test]
    async fn user_message_racing_retirement_reaches_replacement_queue_once() {
        let (old, _updates, old_guard) = fixture();
        let chat = old.chat_id.as_deref().unwrap().to_owned();
        age(&old);
        assert!(old.try_retire_idle(Instant::now()));
        let (result, (replacement, _rx, _guard)) = tokio::join!(
            crate::agent_graph::user_ops::user_send_message("idle", "task", &chat, "hello"),
            async {
                tokio::task::yield_now().await;
                drop(old_guard);
                let next = new_handle_for_test(&old.key, "idle", "task", &chat);
                next.0.set_session_restore_capabilities(true, false);
                next.0
                    .is_busy
                    .store(true, std::sync::atomic::Ordering::Release);
                next
            },
        );
        result.unwrap();
        assert!(old.get_queue().is_empty());
        let queue = replacement.get_queue();
        assert_eq!(queue.len(), 1);
        assert_eq!(queue[0].text, "hello");
        // Neither the operation guard nor a failed admission leaks.
        replacement
            .is_busy
            .store(false, std::sync::atomic::Ordering::Release);
        replacement.pending_queue.lock().unwrap().clear();
        age(&replacement);
        assert!(replacement.try_retire_idle(Instant::now()));
    }

    #[tokio::test]
    async fn automatic_reminder_does_not_restart_retiring_runtime() {
        let (handle, _updates, _guard) = fixture();
        age(&handle);
        assert!(handle.try_retire_idle(Instant::now()));
        let result = crate::agent_graph::tools::deliver_user_remind(
            "idle",
            "task",
            handle.chat_id.as_deref().unwrap(),
            "reminder".into(),
        )
        .await;
        assert_eq!(result.unwrap_err(), "target_not_idle");
        assert!(handle.is_retiring());
        assert!(!handle.is_busy.load(std::sync::atomic::Ordering::Acquire));
        assert!(handle.get_queue().is_empty());
    }

    #[tokio::test]
    async fn idle_command_loop_exits_and_refuses_late_submissions() {
        let (handle, _updates, _guard) = fixture();
        let (_tx, mut rx) = mpsc::channel(1);
        age(&handle);
        let result = tokio::time::timeout(
            Duration::from_secs(1),
            handle.next_command_with_interval(&mut rx, Duration::from_millis(1)),
        )
        .await
        .unwrap();
        assert!(result.is_none());
        assert!(handle
            .send_prompt("too late".into(), vec![], None, false, None)
            .await
            .is_err());
        assert!(handle
            .submit_queued_message(QueuedMessage::new(
                "too late".into(),
                vec![],
                None,
                false,
                None
            ))
            .await
            .is_err());
        assert!(handle.get_queue().is_empty());
    }

    #[tokio::test]
    async fn busy_command_loop_stays_alive_until_cancel_arrives() {
        let (handle, _updates, _guard) = fixture();
        let (tx, mut rx) = mpsc::channel(1);
        handle
            .is_busy
            .store(true, std::sync::atomic::Ordering::Release);
        age(&handle);
        let result = tokio::time::timeout(
            Duration::from_millis(10),
            handle.next_command_with_interval(&mut rx, Duration::from_millis(1)),
        )
        .await;
        assert!(result.is_err());
        assert!(!handle.is_retiring());
        tx.send(AcpCommand::Cancel).await.unwrap();
        assert!(matches!(
            handle.next_command(&mut rx).await,
            Some(AcpCommand::Cancel)
        ));
    }

    #[tokio::test]
    async fn business_output_and_active_subagents_protect_headless_runtime() {
        let _lock = crate::storage::database::test_lock().lock().await;
        let temp = tempfile::tempdir().unwrap();
        crate::storage::set_grove_dir_override(Some(temp.path().to_owned()));
        let (handle, _updates, _guard) = fixture();
        age(&handle);
        handle.emit(AcpUpdate::MessageChunk {
            message_id: None,
            text: "still working".into(),
        });
        assert!(!handle.try_retire_idle(Instant::now()));
        for status in ["running", "unknown", "idle"] {
            let update = serde_json::from_value(serde_json::json!({
                "sessionId": "child", "state": {"state": status}
            }))
            .unwrap();
            handle.register_subagent("session-test", update);
            age(&handle);
            assert_eq!(handle.try_retire_idle(Instant::now()), status == "idle");
        }
        crate::storage::set_grove_dir_override(None);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn host_terminal_keeps_idle_agent_alive_until_process_exits() {
        let (handle, _updates, _guard) = fixture();
        let terminals = Arc::new(Mutex::new(HashMap::new()));
        let state = super::super::tests::client_state_for_test(handle.clone(), terminals.clone());
        let created = handle_create_terminal(
            &state,
            acp::CreateTerminalRequest::new("session-test", "sleep").args(vec!["0.1".into()]),
        )
        .await
        .unwrap();
        let mut exit_rx = terminals
            .lock()
            .unwrap()
            .get(&created.terminal_id.to_string())
            .unwrap()
            .exit_tx
            .subscribe();
        age(&handle);
        assert!(!handle.is_busy.load(std::sync::atomic::Ordering::Acquire));
        assert!(!handle.try_retire_idle(Instant::now()));
        tokio::time::timeout(
            Duration::from_secs(5),
            exit_rx.wait_for(|status| status.is_some()),
        )
        .await
        .unwrap()
        .unwrap();
        // The terminal task releases its lease as it finishes.
        tokio::task::yield_now().await;
        age(&handle);
        assert!(handle.try_retire_idle(Instant::now()));
    }

    #[derive(Default)]
    struct TestConnectAdapter {
        errors: Mutex<Vec<String>>,
    }

    #[async_trait::async_trait]
    impl crate::connect::adapter::ConnectAdapter for TestConnectAdapter {
        async fn mark_waiting(&self, _: &str) -> Option<String> {
            None
        }
        async fn mark_working(&self, _: &str, _: &Option<String>) -> Option<String> {
            None
        }
        async fn clear_status(&self, _: &str, _: &Option<String>) {}
        async fn reply_text(&self, _: &str, text: &str) -> Result<(), String> {
            self.errors.lock().unwrap().push(text.into());
            Ok(())
        }
        async fn reply_card(
            &self,
            _: &str,
            _: &crate::connect::commands::CardSpec,
        ) -> Result<(), String> {
            Ok(())
        }
    }

    #[tokio::test]
    async fn feishu_message_racing_retirement_reaches_replacement_queue_once() {
        let _lock = crate::storage::database::test_lock().lock().await;
        let temp = tempfile::tempdir().unwrap();
        crate::storage::set_grove_dir_override(Some(temp.path().to_owned()));
        let (old, _updates, old_guard) = fixture();
        let chat = old.chat_id.as_deref().unwrap().to_owned();
        crate::storage::tasks::add_chat_session(
            "idle",
            "task",
            crate::storage::tasks::ChatSession {
                id: chat.clone(),
                title: "Idle test".into(),
                agent: "claude-acp".into(),
                acp_session_id: None,
                created_at: chrono::Utc::now(),
                duty: None,
                launch_mode: "acp".into(),
            },
        )
        .unwrap();
        let connect = crate::storage::connects::create(crate::storage::connects::ConnectInput {
            name: "Idle test".into(),
            platform: "feishu".into(),
            domain: "feishu".into(),
            enabled: true,
            adapter_config: serde_json::json!({}),
            project_id: "idle".into(),
            task_id: "task".into(),
            session_id: chat.clone(),
        })
        .unwrap();
        let adapter = Arc::new(TestConnectAdapter::default());
        age(&old);
        assert!(old.try_retire_idle(Instant::now()));
        let inbound = crate::connect::adapter::InboundMessage {
            external_message_id: "incoming".into(),
            conversation_id: "private-chat".into(),
            sender_id: "user".into(),
            text: "continue from Feishu".into(),
            attachments: vec![],
        };
        let (_, (replacement, _rx, _guard)) = tokio::join!(
            crate::connect::core::handle_message(&connect.id, adapter.clone(), inbound),
            async {
                tokio::task::yield_now().await;
                drop(old_guard);
                let next = new_handle_for_test(&old.key, "idle", "task", &chat);
                next.0.set_session_restore_capabilities(true, false);
                next.0
                    .is_busy
                    .store(true, std::sync::atomic::Ordering::Release);
                next
            },
        );
        assert!(
            adapter.errors.lock().unwrap().is_empty(),
            "{:?}",
            adapter.errors
        );
        let queue = replacement.get_queue();
        assert_eq!(queue.len(), 1);
        assert_eq!(queue[0].text, "continue from Feishu");
        assert!(replacement
            .is_busy
            .load(std::sync::atomic::Ordering::Acquire));
        let saved = crate::storage::connects::get(&connect.id).unwrap().unwrap();
        assert!(saved.enabled);
        assert_eq!(saved.session_id, chat);
        // The durable Connect binding itself is not an observer/idle exemption.
        replacement
            .is_busy
            .store(false, std::sync::atomic::Ordering::Release);
        age(&replacement);
        assert!(!replacement.try_retire_idle(Instant::now()));
        replacement.pending_queue.lock().unwrap().clear();
        assert!(replacement.try_retire_idle(Instant::now()));
        crate::storage::set_grove_dir_override(None);
    }

    #[tokio::test]
    async fn every_observer_protects_runtime_and_detach_does_not_restart_idle_clock() {
        let (handle, _updates, _guard) = fixture();
        assert!(!handle.try_retire_idle(Instant::now()));
        age(&handle);
        let first = handle.attach_observer().unwrap();
        let second = handle.attach_observer().unwrap();
        assert!(!handle.try_retire_idle(Instant::now()));
        drop(first);
        assert!(!handle.try_retire_idle(Instant::now()));
        drop(second);
        assert!(handle.try_retire_idle(Instant::now()));
        assert!(handle.attach_observer().is_err());
        assert!(handle.begin_activity().is_err());
    }

    #[tokio::test]
    async fn long_silent_operations_protect_runtime_and_completion_restarts_clock() {
        let (handle, _updates, _guard) = fixture();
        let operation = handle.begin_activity().unwrap();
        age(&handle);
        assert!(!handle.try_retire_idle(Instant::now()));
        drop(operation);
        assert!(!handle.try_retire_idle(Instant::now()));
        age(&handle);
        assert!(handle.try_retire_idle(Instant::now()));
    }

    #[tokio::test]
    async fn busy_queue_permission_auth_tool_and_terminal_each_prevent_retirement() {
        let (handle, _updates, _guard) = fixture();
        age(&handle);
        handle
            .is_busy
            .store(true, std::sync::atomic::Ordering::Release);
        assert!(!handle.try_retire_idle(Instant::now()));
        handle
            .is_busy
            .store(false, std::sync::atomic::Ordering::Release);
        handle
            .pending_queue
            .lock()
            .unwrap()
            .push(QueuedMessage::new(
                "pending".into(),
                vec![],
                None,
                false,
                None,
            ));
        handle
            .queue_paused
            .store(true, std::sync::atomic::Ordering::Relaxed);
        assert!(!handle.try_retire_idle(Instant::now()));
        handle.pending_queue.lock().unwrap().clear();
        let (tx, _rx) = tokio::sync::oneshot::channel();
        *handle.pending_permission.lock().unwrap() = Some(("permission".into(), tx));
        assert!(!handle.try_retire_idle(Instant::now()));
        handle.pending_permission.lock().unwrap().take();
        *handle.pending_auth.lock().unwrap() = Some(PendingAuthState {
            methods: vec![],
            agent_name: None,
        });
        assert!(!handle.try_retire_idle(Instant::now()));
        handle.pending_auth.lock().unwrap().take();
        handle.terminal_auth.lock().unwrap().reconnecting = true;
        assert!(!handle.try_retire_idle(Instant::now()));
        handle.terminal_auth.lock().unwrap().reconnecting = false;
        handle
            .active_tool_calls
            .lock()
            .unwrap()
            .insert("silent-tool".into());
        assert!(!handle.try_retire_idle(Instant::now()));
        handle.active_tool_calls.lock().unwrap().clear();
        *handle.terminal_kill_tx.lock().unwrap() = Some(mpsc::channel(1).0);
        assert!(!handle.try_retire_idle(Instant::now()));
        handle.terminal_kill_tx.lock().unwrap().take();
        assert!(handle.try_retire_idle(Instant::now()));
    }

    #[tokio::test]
    async fn pending_form_and_open_url_elicitation_prevent_retirement() {
        let (handle, _updates, _guard) = fixture();
        let snapshot = ElicitationRequestSnapshot {
            request_id: "form".into(),
            agent_name: "test".into(),
            opened: false,
            request: acp::CreateElicitationRequest::new(
                acp::ElicitationFormMode::new(
                    acp::ElicitationSessionScope::new("session-test"),
                    acp::ElicitationSchema::new().string("name", true),
                ),
                "Name",
            ),
        };
        *handle.pending_elicitation.lock().unwrap() = Some(PendingElicitation {
            snapshot: snapshot.clone(),
            response_tx: tokio::sync::oneshot::channel().0,
        });
        age(&handle);
        assert!(!handle.try_retire_idle(Instant::now()));
        handle.pending_elicitation.lock().unwrap().take();
        handle
            .active_url_elicitations
            .lock()
            .unwrap()
            .insert("url".into(), snapshot);
        assert!(!handle.try_retire_idle(Instant::now()));
        handle.active_url_elicitations.lock().unwrap().clear();
        assert!(handle.try_retire_idle(Instant::now()));
    }

    #[tokio::test]
    async fn buffered_command_wins_over_idle_retirement() {
        let (handle, _updates, _guard) = fixture();
        let (tx, mut rx) = mpsc::channel(1);
        age(&handle);
        tx.send(AcpCommand::Cancel).await.unwrap();
        assert!(matches!(
            handle.next_command(&mut rx).await,
            Some(AcpCommand::Cancel)
        ));
        assert!(!handle.is_retiring());
        assert!(!handle.try_retire_idle(Instant::now()));
    }

    #[tokio::test]
    async fn observer_or_message_admission_and_retirement_have_one_atomic_winner() {
        for observer in [true, false].into_iter().cycle().take(64) {
            let (handle, _updates, _guard) = fixture();
            age(&handle);
            let barrier = Arc::new(std::sync::Barrier::new(2));
            let other = handle.clone();
            let thread_barrier = barrier.clone();
            let attachment = std::thread::spawn(move || {
                thread_barrier.wait();
                if observer {
                    other.attach_observer()
                } else {
                    other.begin_activity()
                }
            });
            barrier.wait();
            let retired = handle.try_retire_idle(Instant::now());
            let observer = attachment.join().unwrap();
            assert_eq!(retired, observer.is_err());
        }
    }

    #[tokio::test]
    async fn connect_preparation_protects_runtime_but_does_not_pin_it_forever() {
        let (handle, _updates, _guard) = fixture();
        let chat = handle.chat_id.as_deref().unwrap();
        age(&handle);
        let session = crate::grove::ensure_session("idle", "task", chat)
            .await
            .unwrap();
        // Simulate an arbitrarily slow attachment preparation step.
        age(&handle);
        assert!(!handle.try_retire_idle(Instant::now()));
        let prompt = session.prepare_prompt("Feishu input".into(), vec![], Some("connect".into()));
        drop(session);
        assert!(!handle.try_retire_idle(Instant::now()));
        drop(prompt);
        age(&handle);
        assert!(handle.try_retire_idle(Instant::now()));
    }

    #[tokio::test]
    async fn connect_waits_for_retiring_owner_and_uses_replacement() {
        let (old, _updates, old_guard) = fixture();
        let chat = old.chat_id.as_deref().unwrap().to_owned();
        age(&old);
        assert!(old.try_retire_idle(Instant::now()));
        let (session, (replacement, _rx, _guard)) =
            tokio::join!(crate::grove::ensure_session("idle", "task", &chat), async {
                tokio::task::yield_now().await;
                drop(old_guard);
                let next = new_handle_for_test(&old.key, "idle", "task", &chat);
                next.0.set_session_restore_capabilities(true, false);
                next
            },);
        let session = session.unwrap();
        age(&replacement);
        assert!(!replacement.try_retire_idle(Instant::now()));
        assert!(old.is_retiring());
        drop(session);
        age(&replacement);
        assert!(replacement.try_retire_idle(Instant::now()));
    }
}

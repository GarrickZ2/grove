//! Out-of-band, interactive authentication for locally launched ACP agents.

use super::*;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AuthMethodKind {
    #[default]
    Agent,
    Terminal,
}

#[derive(Clone)]
pub(crate) struct TerminalAuthLaunch {
    pub program: PathBuf,
    pub args: Vec<String>,
    pub env: HashMap<String, String>,
    pub cwd: PathBuf,
}

#[derive(Default)]
pub(super) struct TerminalAuthState {
    pub launch: Option<TerminalAuthLaunch>,
    active: Option<String>,
    pub reconnecting: bool,
}

/// Dropping an attempt (including a revoked/disconnected socket) cancels login.
/// Only the attempt that still owns the slot can change authentication state.
pub(crate) struct TerminalAuthAttempt {
    handle: Arc<AcpSessionHandle>,
    id: String,
    pub launch: TerminalAuthLaunch,
}

impl TerminalAuthAttempt {
    pub fn shutdown(&self) -> tokio::sync::watch::Receiver<bool> {
        self.handle.shutdown_tx.subscribe()
    }

    pub fn finish(self, result: std::result::Result<(), String>) {
        self.complete(result);
    }

    fn complete(&self, result: std::result::Result<(), String>) {
        let mut state = self.handle.terminal_auth.lock().unwrap();
        if state.active.as_deref() != Some(&self.id) {
            return;
        }
        state.active = None;
        if *self.handle.shutdown_tx.borrow() {
            return;
        }
        match result {
            Ok(()) => {
                state.reconnecting = true;
                self.handle
                    .readiness
                    .send_replace(SessionReadiness::Starting);
                self.handle
                    .terminal_auth_restart
                    .send_modify(|generation| *generation += 1);
            }
            Err(message) => {
                drop(state);
                self.handle.emit(AcpUpdate::AuthFailed { message });
            }
        }
    }
}

impl Drop for TerminalAuthAttempt {
    fn drop(&mut self) {
        self.complete(Err("Terminal sign-in was cancelled or disconnected".into()));
    }
}

impl AcpSessionHandle {
    pub(super) fn terminal_auth_in_progress(&self) -> bool {
        let state = self.terminal_auth.lock().unwrap();
        state.active.is_some() || state.reconnecting
    }

    pub(crate) fn begin_terminal_auth(
        self: &Arc<Self>,
        method_id: &str,
    ) -> std::result::Result<TerminalAuthAttempt, String> {
        let method = self
            .auth_methods
            .lock()
            .unwrap()
            .iter()
            .find(|method| method.id == method_id && method.kind == AuthMethodKind::Terminal)
            .and_then(|method| method.terminal.clone())
            .ok_or("Agent did not advertise this terminal authentication method")?;
        let mut state = self.terminal_auth.lock().unwrap();
        if state.active.is_some() || state.reconnecting {
            return Err("Terminal sign-in is already in progress".into());
        }
        if self.is_busy.load(std::sync::atomic::Ordering::Relaxed) || *self.shutdown_tx.borrow() {
            return Err("Wait for the current operation to finish before signing in".into());
        }
        let mut launch = state
            .launch
            .clone()
            .ok_or("Terminal sign-in requires a local agent")?;
        launch.args.extend(method.args);
        launch.env.extend(method.env);
        let id = uuid::Uuid::new_v4().to_string();
        state.active = Some(id.clone());
        drop(state);
        *self.pending_auth.lock().unwrap() = Some(PendingAuthState {
            methods: self.auth_methods.lock().unwrap().clone(),
            agent_name: self
                .agent_info
                .read()
                .ok()
                .and_then(|info| info.as_ref().map(|(_, name, _)| name.clone())),
        });
        Ok(TerminalAuthAttempt {
            handle: self.clone(),
            id,
            launch,
        })
    }

    pub(super) fn finish_terminal_auth_reconnect(&self) {
        let reconnecting = {
            let mut state = self.terminal_auth.lock().unwrap();
            std::mem::take(&mut state.reconnecting)
        };
        if reconnecting {
            self.pending_auth.lock().unwrap().take();
            self.emit(AcpUpdate::AuthSucceeded);
            let retry = self.pending_auth_retry.lock().unwrap().take();
            if let Some(retry) = retry {
                self.retry_prompt_after_auth(retry);
            } else {
                self.drain_queue_if_ready();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TestStorage(tempfile::TempDir);

    impl TestStorage {
        fn new() -> Self {
            let dir = tempfile::tempdir().unwrap();
            crate::storage::set_grove_dir_override(Some(dir.path().into()));
            Self(dir)
        }
    }

    impl Drop for TestStorage {
        fn drop(&mut self) {
            crate::storage::set_grove_dir_override(None);
        }
    }

    fn terminal_method() -> acp::AuthMethod {
        acp::AuthMethod::Terminal(
            acp::AuthMethodTerminal::new("terminal-login", "Terminal login")
                .args(vec!["--login".into(), "a b;$(echo nope)".into()])
                .env(HashMap::from([("AUTH_MODE".into(), "login".into())])),
        )
    }

    #[test]
    fn terminal_auth_is_opt_in_and_never_uses_authenticate() {
        let method = terminal_method();
        assert!(auth_method_info(&method, false).is_none());
        let method = auth_method_info(&method, true).unwrap();
        assert!(!is_advertised_auth_method(
            std::slice::from_ref(&method),
            &method.id
        ));
        let serialized = serde_json::to_value(&method).unwrap();
        assert_eq!(serialized["type"], "terminal");
        assert!(serialized.get("args").is_none());
        assert!(serialized.get("env").is_none());
        assert!(grove_client_capabilities_for_transport(true).auth.terminal);
        assert!(!grove_client_capabilities_for_transport(false).auth.terminal);
    }

    #[tokio::test]
    async fn terminal_auth_preserves_invocation_and_requires_reconnect_before_success() {
        let _lock = crate::storage::database::test_lock().lock().await;
        let _storage = TestStorage::new();
        let (handle, mut updates, _guard) =
            new_handle_for_test(&uuid::Uuid::new_v4().to_string(), "project", "task", "chat");
        *handle.auth_methods.lock().unwrap() =
            vec![auth_method_info(&terminal_method(), true).unwrap()];
        handle.terminal_auth.lock().unwrap().launch = Some(TerminalAuthLaunch {
            program: PathBuf::from("/configured/agent"),
            args: vec!["--acp".into()],
            env: HashMap::from([
                ("AUTH_MODE".into(), "base".into()),
                ("BASE_ONLY".into(), "kept".into()),
            ]),
            cwd: PathBuf::from("/configured/workdir"),
        });
        assert!(handle.authenticate("terminal-login".into()).await.is_err());
        assert!(handle.begin_terminal_auth("invented").is_err());
        let attempt = handle.begin_terminal_auth("terminal-login").unwrap();
        assert_eq!(attempt.launch.program, PathBuf::from("/configured/agent"));
        assert_eq!(
            attempt.launch.args,
            ["--acp", "--login", "a b;$(echo nope)"]
        );
        assert_eq!(attempt.launch.env["AUTH_MODE"], "login");
        assert_eq!(attempt.launch.env["BASE_ONLY"], "kept");
        assert_eq!(attempt.launch.cwd, PathBuf::from("/configured/workdir"));
        assert!(handle.begin_terminal_auth("terminal-login").is_err());
        let mut restart = handle.terminal_auth_restart.subscribe();
        attempt.finish(Ok(()));
        restart.changed().await.unwrap();
        assert!(
            updates.try_recv().is_err(),
            "process exit alone must not emit AuthSucceeded"
        );
        assert!(handle.pending_auth.lock().unwrap().is_some());
        assert!(handle.begin_terminal_auth("terminal-login").is_err());
        handle.finish_terminal_auth_reconnect();
        assert!(matches!(
            updates.try_recv().unwrap(),
            AcpUpdate::AuthSucceeded
        ));
        assert!(handle.pending_auth.lock().unwrap().is_none());
        assert!(!handle.terminal_auth_in_progress());
    }

    #[tokio::test]
    async fn failed_or_cancelled_terminal_auth_can_retry_without_reconnecting() {
        let _lock = crate::storage::database::test_lock().lock().await;
        let _storage = TestStorage::new();
        let (handle, mut updates, _guard) =
            new_handle_for_test(&uuid::Uuid::new_v4().to_string(), "project", "task", "chat");
        *handle.auth_methods.lock().unwrap() =
            vec![auth_method_info(&terminal_method(), true).unwrap()];
        // A remote session has no local launch configuration.
        assert!(handle.begin_terminal_auth("terminal-login").is_err());
        handle.terminal_auth.lock().unwrap().launch = Some(TerminalAuthLaunch {
            program: PathBuf::from("agent"),
            args: Vec::new(),
            env: HashMap::new(),
            cwd: PathBuf::from("/tmp"),
        });
        let restart = handle.terminal_auth_restart.subscribe();
        drop(handle.begin_terminal_auth("terminal-login").unwrap());
        assert!(matches!(
            updates.try_recv().unwrap(),
            AcpUpdate::AuthFailed { .. }
        ));
        assert!(!restart.has_changed().unwrap());
        handle
            .begin_terminal_auth("terminal-login")
            .unwrap()
            .finish(Err("exit 7".into()));
        assert!(
            matches!(updates.try_recv().unwrap(), AcpUpdate::AuthFailed { message } if message == "exit 7")
        );
        assert!(!restart.has_changed().unwrap());
        assert!(handle.pending_auth.lock().unwrap().is_some());
    }

    /// Exercise the real SDK transport, subprocess restart, initialization and
    /// retry path. The fixture also refuses authenticate, so routing a terminal
    /// method through ACP would fail this test.
    #[cfg(unix)]
    async fn exercise_terminal_login(mode: &str, answer: Option<&str>) {
        let _lock = crate::storage::database::test_lock().lock().await;
        let _storage = TestStorage::new();
        use futures::{SinkExt, StreamExt};
        let dir = tempfile::tempdir().unwrap();
        let script = dir.path().join("agent.sh");
        let marker = dir.path().join("logged-in");
        let trace = dir.path().join("trace");
        std::fs::write(&script, r#"
marker=$1
trace=$2
mode=$3
if [ "$4" = --login ]; then
    printf 'Sign in (yes): '
    IFS= read -r answer
    if [ "$answer" = yes ]; then : > "$marker"; exit 0; fi
    if [ "$answer" = skip ]; then exit 0; fi
    exit 7
fi
while IFS= read -r line; do
    id=${line#*\"id\":}
    id=${id%%,*}
    case "$line" in
        *'"method":"initialize"'*)
            printf 'initialize\n' >> "$trace"
            printf '{"jsonrpc":"2.0","id":%s,"result":{"protocolVersion":1,"agentCapabilities":{},"authMethods":[{"type":"terminal","id":"terminal-login","name":"Sign in","args":["--login"]}]}}\n' "$id" ;;
        *'"method":"session/new"'*)
            if [ "$mode" = bootstrap ] && [ ! -f "$marker" ]; then
                printf '{"jsonrpc":"2.0","id":%s,"error":{"code":-32000,"message":"Sign in"}}\n' "$id"
            else
                printf '{"jsonrpc":"2.0","id":%s,"result":{"sessionId":"fixture-session"}}\n' "$id"
            fi ;;
        *'"method":"session/prompt"'*)
            if [ ! -f "$marker" ]; then
                printf '{"jsonrpc":"2.0","id":%s,"error":{"code":-32000,"message":"Sign in"}}\n' "$id"
            else
                printf 'prompt\n' >> "$trace"
                printf '{"jsonrpc":"2.0","id":%s,"result":{"stopReason":"end_turn"}}\n' "$id"
            fi ;;
        *'"method":"authenticate"'*)
            printf 'unexpected-authenticate\n' >> "$trace"
            exit 9 ;;
    esac
done
"#).unwrap();
        let key = format!("terminal-auth-fixture-{}", uuid::Uuid::new_v4());
        let config = AcpStartConfig {
            agent_command: "/bin/sh".into(),
            agent_name: "fixture".into(),
            agent_args: vec![
                script.to_string_lossy().into(),
                marker.to_string_lossy().into(),
                trace.to_string_lossy().into(),
                mode.into(),
            ],
            working_dir: dir.path().into(),
            env_vars: HashMap::new(),
            project_key: key.clone(),
            task_id: "test".into(),
            chat_id: None,
            artifact_dir: Some(dir.path().join("artifacts")),
            additional_mcp_servers: Vec::new(),
            mcp_server_policy: McpServerPolicy::ExplicitOnly,
            agent_type: "local".into(),
            remote_url: None,
            remote_auth: None,
            suppress_initial_connecting: false,
            import_session: false,
            persona_injection: None,
        };
        let (handle, mut updates) = get_or_start_session(key, config).await.unwrap();
        // Always close the session, even on a failed assertion.
        struct Stop(Arc<AcpSessionHandle>);
        impl Drop for Stop {
            fn drop(&mut self) {
                self.0.shutdown_tx.send_replace(true);
            }
        }
        let _stop = Stop(handle.clone());
        let mut original_id = None;
        tokio::time::timeout(std::time::Duration::from_secs(15), async {
            loop {
                match updates.recv().await.unwrap() {
                    AcpUpdate::SessionReady { .. } if mode == "prompt" => {
                        original_id = Some(
                            handle
                                .send_tracked_prompt(
                                    "original prompt".into(),
                                    Vec::new(),
                                    None,
                                    false,
                                    None,
                                )
                                .await
                                .unwrap(),
                        );
                    }
                    AcpUpdate::AuthRequired { methods, .. } => {
                        assert_eq!(methods[0].kind, AuthMethodKind::Terminal);
                        break;
                    }
                    AcpUpdate::Error { message } => panic!("fixture connection failed: {message}"),
                    _ => {}
                }
            }
            let attempt = handle.begin_terminal_auth("terminal-login").unwrap();
            let mut cmd = portable_pty::CommandBuilder::new(&attempt.launch.program);
            cmd.args(&attempt.launch.args);
            cmd.cwd(&attempt.launch.cwd);
            for (key, value) in &attempt.launch.env {
                cmd.env(key, value);
            }
            let slot = Arc::new(Mutex::new(Some((attempt, cmd))));
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let router = axum::Router::new().route(
                "/terminal",
                axum::routing::get(move |ws: axum::extract::WebSocketUpgrade| {
                    let slot = slot.clone();
                    async move {
                        ws.on_upgrade(move |socket| async move {
                            let (attempt, cmd) = slot.lock().unwrap().take().unwrap();
                            let result = crate::api::handlers::terminal::bridge_pty_terminal(
                                socket, cmd, 80, 24, None, true,
                            )
                            .await;
                            attempt.finish(result);
                        })
                    }
                }),
            );
            let server = tokio::spawn(async move {
                axum::serve(listener, router).await.unwrap();
            });
            struct StopServer(tokio::task::AbortHandle);
            impl Drop for StopServer {
                fn drop(&mut self) {
                    self.0.abort();
                }
            }
            let _server = StopServer(server.abort_handle());
            let (mut socket, _) =
                tokio_tungstenite::connect_async(format!("ws://{address}/terminal"))
                    .await
                    .unwrap();
            let mut output = String::new();
            while !output.contains("Sign in (yes): ") {
                let message = socket.next().await.unwrap().unwrap();
                if let tokio_tungstenite::tungstenite::Message::Text(text) = message {
                    output.push_str(&text);
                }
            }
            if let Some(answer) = answer {
                socket
                    .send(tokio_tungstenite::tungstenite::Message::Text(
                        format!("{answer}\n").into(),
                    ))
                    .await
                    .unwrap();
            } else {
                socket.close(None).await.unwrap();
            }
            let should_fail = answer != Some("yes");
            let mut ready = false;
            let mut succeeded = false;
            loop {
                match updates.recv().await.unwrap() {
                    AcpUpdate::SessionReady { .. } => ready = true,
                    AcpUpdate::AuthSucceeded => {
                        assert!(
                            ready,
                            "login must reconnect and initialize before succeeding"
                        );
                        succeeded = true;
                        if mode == "bootstrap" {
                            break;
                        }
                    }
                    AcpUpdate::PromptCompleted { message_ids, .. } => {
                        assert!(succeeded);
                        assert_eq!(message_ids, vec![original_id.clone().unwrap()]);
                        break;
                    }
                    AcpUpdate::AuthFailed { .. } if should_fail => {
                        assert!(!ready && !succeeded);
                        if answer == Some("skip") {
                            assert!(!handle.terminal_auth_in_progress());
                            drop(handle.begin_terminal_auth("terminal-login").expect(
                                "retry must be available after authentication is rejected again",
                            ));
                        } else {
                            assert!(handle.pending_auth_retry.lock().unwrap().is_some());
                        }
                        let trace = std::fs::read_to_string(&trace).unwrap();
                        assert_eq!(
                            trace.lines().filter(|line| *line == "initialize").count(),
                            if answer == Some("skip") { 2 } else { 1 }
                        );
                        assert!(!trace.contains("unexpected-authenticate"));
                        return;
                    }
                    AcpUpdate::Error { message } | AcpUpdate::AuthFailed { message } => {
                        panic!("fixture login failed: {message}")
                    }
                    _ => {}
                }
            }
            let trace = std::fs::read_to_string(&trace).unwrap();
            assert_eq!(
                trace.lines().filter(|line| *line == "initialize").count(),
                2
            );
            assert!(!trace.contains("unexpected-authenticate"));
            if mode == "prompt" {
                assert_eq!(trace.lines().filter(|line| *line == "prompt").count(), 1);
            }
        })
        .await
        .expect("terminal authentication fixture timed out");
        handle.kill().await.unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            while !matches!(updates.recv().await.unwrap(), AcpUpdate::SessionEnded) {}
        })
        .await
        .expect("fixture Agent did not shut down");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn terminal_auth_reconnects_and_retries_session_bootstrap() {
        exercise_terminal_login("bootstrap", Some("yes")).await;
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn terminal_auth_reconnects_and_retries_original_prompt() {
        exercise_terminal_login("prompt", Some("yes")).await;
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn terminal_auth_nonzero_exit_does_not_retry_or_reconnect() {
        exercise_terminal_login("prompt", Some("no")).await;
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn terminal_auth_disconnect_does_not_retry_or_reconnect() {
        exercise_terminal_login("prompt", None).await;
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn terminal_auth_can_retry_when_reinitialized_agent_still_requires_login() {
        exercise_terminal_login("bootstrap", Some("skip")).await;
    }
}

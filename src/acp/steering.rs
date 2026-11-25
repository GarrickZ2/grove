//! Steering: a message the user sends while the Agent works joins the running
//! turn instead of waiting for it to end. Every message still goes through the
//! queue. What the Agent takes leaves the queue; what it does not stays there
//! and is sent when the turn ends.
use super::{acp, AcpSessionHandle, AcpUpdate, QueuedMessage};
use agent_client_protocol::v2::schema as v2;
use std::sync::{atomic::Ordering, Arc};

/// Pre-standard ACP v1 extension, advertised as `_meta.steering.supported`.
/// In ACP v2 the same flag says that an ordinary prompt joins a running turn.
const STEER_METHOD: &str = "_session/steering";

pub(super) fn advertised(meta: Option<&serde_json::Map<String, serde_json::Value>>) -> bool {
    meta.and_then(|meta| meta.get("steering")?.get("supported")?.as_bool())
        .unwrap_or(false)
}

enum Outcome {
    /// Part of the running turn; in v2, with the Agent's ID for the message.
    Taken(Option<String>),
    Declined,
}

impl AcpSessionHandle {
    /// Offer the queued messages to the running turn, in order.
    pub(crate) fn steer_queue(&self) {
        if !self.can_steer() {
            return;
        }
        let Some(handle) = super::get_session_handle(&self.key)
            .filter(|handle| std::ptr::eq(Arc::as_ptr(handle), self))
        else {
            return;
        };
        if let Ok(runtime) = tokio::runtime::Handle::try_current() {
            runtime.spawn(async move { handle.run_steering().await });
        }
    }

    fn can_steer(&self) -> bool {
        self.steering_capable.load(Ordering::Relaxed)
            && self.is_busy.load(Ordering::Relaxed)
            && self.active_turn_ids().is_some()
            // The turn is being stopped: what is queued runs after it.
            && !self.stop_requested.load(Ordering::Acquire)
            && !self.queue_paused.load(Ordering::Relaxed)
    }

    async fn run_steering(&self) {
        // One at a time: messages join the turn in the order they were sent.
        let _guard = self.steer_lock.lock().await;
        while let Some(message) = self.take_steerable() {
            let ids = message.message_ids.clone();
            let text = match crate::plugins::prompt_middleware::run(
                crate::plugins::prompt_middleware::Phase::Dispatch,
                &self.project_key,
                &self.task_id,
                self.chat_id(),
                &ids,
                message.delivery_text().to_owned(),
                message.sender.as_deref(),
            )
            .await
            {
                Ok(text) => text,
                Err(error) => {
                    self.emit_local_prompt_rejection(ids, error.to_string());
                    self.emit_queue();
                    continue;
                }
            };
            // The turn may have ended, or been stopped, in the meantime.
            let outcome = if self.can_steer() {
                self.steer(&text, &message).await
            } else {
                Outcome::Declined
            };
            match outcome {
                Outcome::Taken(agent_id) => {
                    let client_message_id = (ids.len() == 1).then(|| ids[0].clone());
                    self.cursors.lock().unwrap().steered();
                    self.emit(AcpUpdate::UserMessage {
                        message_id: None,
                        text,
                        client_message_id: client_message_id.clone(),
                        attachments: message.attachments,
                        sender: message.sender,
                        terminal: false,
                    });
                    self.emit_user_message_time(&ids, client_message_id.clone());
                    if let (Some(client_message_id), Some(message_id)) =
                        (client_message_id, agent_id)
                    {
                        self.emit(AcpUpdate::V2MessageBind {
                            client_message_id,
                            message_id,
                        });
                    }
                    self.emit_queue();
                }
                Outcome::Declined => {
                    self.pending_queue.lock().unwrap().insert(0, message);
                    self.emit_queue();
                    self.drain_queue_if_ready();
                    return;
                }
            }
        }
    }

    fn emit_queue(&self) {
        self.emit(AcpUpdate::QueueUpdate {
            messages: self.get_queue(),
        });
    }

    /// Take the first queued message, when it is one that can join the turn. A
    /// later message never overtakes one that has to wait.
    fn take_steerable(&self) -> Option<QueuedMessage> {
        if !self.can_steer() {
            return None;
        }
        let mut queue = self.pending_queue.lock().unwrap();
        let first = queue.first()?;
        let steerable = matches!(first.sender.as_deref(), None | Some("user"))
            && !first.terminal
            // Commands run as a turn of their own.
            && !first.text.trim_start().starts_with('/')
            && first
                .config
                .as_ref()
                .is_none_or(|config| self.has_config(config));
        steerable.then(|| queue.remove(0))
    }

    /// Whether the session already runs with the settings the message asks for.
    fn has_config(&self, config: &super::QueuedConfig) -> bool {
        if !config.config_options.is_empty() {
            let current = self.current_config_options.lock().unwrap();
            return config.config_options.iter().all(|(id, value)| {
                current
                    .iter()
                    .find(|option| option.id.to_string() == *id)
                    // An option the Agent no longer offers is not applied either.
                    .is_none_or(|option| {
                        crate::agent_config::config_option_has_current_value(option, value)
                    })
            });
        }
        let same = |wanted: &Option<String>, current: &std::sync::Mutex<Option<String>>| {
            wanted.is_none() || *wanted == *current.lock().unwrap()
        };
        same(&config.mode, &self.current_mode_id)
            && same(&config.model, &self.current_model_id)
            && same(&config.thought_level, &self.current_thought_level_id)
    }

    /// An error means the Agent did not take the message.
    async fn steer(&self, text: &str, message: &QueuedMessage) -> Outcome {
        let Some(session_id) = self
            .agent_info
            .read()
            .unwrap()
            .as_ref()
            .map(|(session_id, _, _)| session_id.clone())
        else {
            return Outcome::Declined;
        };
        let mut prompt = vec![acp::ContentBlock::Text(acp::TextContent::new(text))];
        prompt.extend(message.attachments.iter().map(super::to_acp_content_block));
        let v2_connection = self.subagent_connection_v2.lock().unwrap().clone();
        if let Some(connection) = v2_connection {
            let Ok(prompt) = serde_json::to_value(prompt)
                .and_then(serde_json::from_value::<Vec<v2::ContentBlock>>)
            else {
                return Outcome::Declined;
            };
            return match connection
                .send_request(v2::PromptRequest::new(session_id, prompt))
                .block_task()
                .await
            {
                Ok(response) => Outcome::Taken(Some(response.message_id.to_string())),
                Err(_) => Outcome::Declined,
            };
        }
        let connection = self.subagent_connection.lock().unwrap().clone();
        let Some(connection) = connection else {
            return Outcome::Declined;
        };
        let Ok(request) = agent_client_protocol::UntypedMessage::new(
            STEER_METHOD,
            serde_json::json!({
                "sessionId": session_id,
                "prompt": prompt,
                // Grove sends what finds no running turn as a normal prompt.
                "_meta": {"steering": {"idleBehavior": "promptRequired"}},
            }),
        ) else {
            return Outcome::Declined;
        };
        match connection.send_request(request).block_task().await {
            Ok(response)
                if matches!(
                    response.get("outcome").and_then(|outcome| outcome.as_str()),
                    Some("injected" | "startedNewTurn")
                ) =>
            {
                Outcome::Taken(None)
            }
            _ => Outcome::Declined,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::{AcpStartConfig, McpServerPolicy};
    use super::*;
    use std::collections::HashMap;

    const PYTHON: &str = if cfg!(windows) {
        "python"
    } else {
        "/usr/bin/python3"
    };

    /// Holds a prompt open until it is steered with "finish" or cancelled.
    const V1_AGENT: &str = r#"
import json, sys
open_prompt = None
def send(msg): print(json.dumps(msg), flush=True)
def log(kind, text):
    with open(sys.argv[1], 'a') as f: f.write(kind + ':' + text + '\n')
for line in sys.stdin:
    req = json.loads(line); method = req.get('method'); ident = req.get('id'); params = req.get('params') or {}
    text = params['prompt'][0]['text'] if params.get('prompt') else ''
    if method == 'initialize':
        send({'jsonrpc':'2.0','id':ident,'result':{'protocolVersion':1,'agentInfo':{'name':'fixture','version':'1'},'authMethods':[],
              'agentCapabilities':{},'_meta':{'steering':{'supported':True}}}})
    elif method == 'session/new': send({'jsonrpc':'2.0','id':ident,'result':{'sessionId':'s'}})
    elif method == 'session/prompt':
        log('prompt', text)
        if 'hold' in text: open_prompt = ident
        else: send({'jsonrpc':'2.0','id':ident,'result':{'stopReason':'end_turn'}})
    elif method == '_session/steering':
        assert params['_meta']['steering']['idleBehavior'] == 'promptRequired'
        declined = 'decline' in text or open_prompt is None
        log('declined' if declined else 'steer', text)
        send({'jsonrpc':'2.0','id':ident,'result':{'outcome':'promptRequired','reason':'noRunningTurn'} if declined else {'outcome':'injected'}})
        if 'finish' in text and open_prompt is not None:
            send({'jsonrpc':'2.0','id':open_prompt,'result':{'stopReason':'end_turn'}}); open_prompt = None
    elif method == 'session/cancel' and open_prompt is not None:
        send({'jsonrpc':'2.0','id':open_prompt,'result':{'stopReason':'cancelled'}}); open_prompt = None
    elif ident is not None: send({'jsonrpc':'2.0','id':ident,'result':{}})
"#;

    /// Answers a prompt sent during a turn as part of it.
    const V2_AGENT: &str = r#"
import json, sys
running = False
def send(msg): print(json.dumps(msg), flush=True)
def update(data): send({'jsonrpc':'2.0','method':'session/update','params':{'sessionId':'s','update':data}})
def log(kind, text):
    with open(sys.argv[1], 'a') as f: f.write(kind + ':' + text + '\n')
count = 0
for line in sys.stdin:
    req = json.loads(line); method = req.get('method'); ident = req.get('id'); params = req.get('params') or {}
    text = params['prompt'][0]['text'] if params.get('prompt') else ''
    if method == 'initialize':
        send({'jsonrpc':'2.0','id':ident,'result':{'protocolVersion':2,'info':{'name':'fixture','version':'1'},
              'capabilities':{'session':{}},'_meta':{'steering':{'supported':True}}}})
    elif method == 'session/new': send({'jsonrpc':'2.0','id':ident,'result':{'sessionId':'s','configOptions':[]}})
    elif method == 'session/prompt':
        count += 1; log('steer' if running else 'prompt', text)
        mid = 'u%d' % count
        if not running: running = True; update({'sessionUpdate':'state_update','state':'running'})
        update({'sessionUpdate':'user_message','messageId':mid,'content':[{'type':'text','text':text}]})
        send({'jsonrpc':'2.0','id':ident,'result':{'messageId':mid}})
        if 'finish' in text: running = False; update({'sessionUpdate':'state_update','state':'idle','stopReason':'end_turn'})
    elif ident is not None: send({'jsonrpc':'2.0','id':ident,'result':{}})
"#;

    struct Reset;
    impl Drop for Reset {
        fn drop(&mut self) {
            crate::storage::set_grove_dir_override(None);
        }
    }

    async fn start(
        dir: &std::path::Path,
        version: u8,
    ) -> (
        Arc<AcpSessionHandle>,
        tokio::sync::broadcast::Receiver<AcpUpdate>,
        std::path::PathBuf,
    ) {
        let agent = format!("steer-v{version}");
        crate::storage::installed_agents::patch_or_create(&agent, None, None, None, None).unwrap();
        crate::storage::installed_agents::set_acp_protocol_version(&agent, version).unwrap();
        let script = dir.join(format!("{agent}.py"));
        std::fs::write(&script, if version == 2 { V2_AGENT } else { V1_AGENT }).unwrap();
        let trace = dir.join(format!("{agent}.log"));
        let key = format!("{agent}-{}", uuid::Uuid::new_v4());
        let config = AcpStartConfig {
            agent_command: PYTHON.into(),
            agent_name: agent,
            agent_args: vec![
                script.to_string_lossy().into_owned(),
                trace.to_string_lossy().into_owned(),
            ],
            working_dir: dir.into(),
            env_vars: HashMap::new(),
            project_key: key.clone(),
            task_id: "task".into(),
            chat_id: Some("chat".into()),
            artifact_dir: Some(dir.join("artifacts")),
            additional_mcp_servers: Vec::new(),
            mcp_server_policy: McpServerPolicy::ExplicitOnly,
            agent_type: "local".into(),
            remote_url: None,
            remote_auth: None,
            suppress_initial_connecting: false,
            import_session: false,
            persona_injection: None,
        };
        let (handle, mut events) = super::super::get_or_start_session(key, config)
            .await
            .unwrap();
        wait(&mut events, |event| {
            matches!(
                event,
                AcpUpdate::SessionReady {
                    steering_capable: true,
                    ..
                }
            )
        })
        .await;
        (handle, events, trace)
    }

    async fn wait(
        events: &mut tokio::sync::broadcast::Receiver<AcpUpdate>,
        mut found: impl FnMut(&AcpUpdate) -> bool,
    ) {
        tokio::time::timeout(std::time::Duration::from_secs(15), async {
            loop {
                let event = events.recv().await.unwrap();
                if let AcpUpdate::Error { message } = &event {
                    panic!("{message}");
                }
                if found(&event) {
                    return;
                }
            }
        })
        .await
        .expect("expected event");
    }

    async fn wait_for_user(
        events: &mut tokio::sync::broadcast::Receiver<AcpUpdate>,
        expected: &str,
    ) {
        wait(
            events,
            |event| matches!(event, AcpUpdate::UserMessage { text, .. } if text == expected),
        )
        .await;
    }

    async fn submit(handle: &Arc<AcpSessionHandle>, text: &str, sender: Option<&str>) {
        let messages = handle
            .submit_queued_message(QueuedMessage::new(
                text.into(),
                Vec::new(),
                sender.map(str::to_owned),
                false,
                Some(handle.snapshot_config()),
            ))
            .await
            .unwrap();
        handle.emit(AcpUpdate::QueueUpdate { messages });
        handle.steer_queue();
    }

    async fn wait_for_log(trace: &std::path::Path, expected: &[&str]) {
        let read = || std::fs::read_to_string(trace).unwrap_or_default();
        tokio::time::timeout(std::time::Duration::from_secs(10), async {
            while read().lines().collect::<Vec<_>>() != expected {
                tokio::time::sleep(std::time::Duration::from_millis(30)).await;
            }
        })
        .await
        .unwrap_or_else(|_| panic!("expected {expected:?}, got {:?}", read()));
    }

    #[tokio::test]
    async fn v1_messages_join_the_running_turn_or_wait_in_the_queue() {
        let _lock = crate::storage::database::test_lock().lock().await;
        let dir = tempfile::tempdir().unwrap();
        crate::storage::set_grove_dir_override(Some(dir.path().to_path_buf()));
        let _reset = Reset;
        let (handle, mut events, trace) = start(dir.path(), 1).await;
        handle
            .send_prompt("hold one".into(), Vec::new(), None, false, None)
            .await
            .unwrap();
        wait_for_log(&trace, &["prompt:hold one"]).await;

        submit(&handle, "also this", None).await;
        submit(&handle, "and that", None).await;
        wait_for_user(&mut events, "also this").await;
        wait_for_user(&mut events, "and that").await;
        assert!(handle.get_queue().is_empty());

        // What the Agent declines, another Agent's message, and what comes
        // behind them all wait for the turn to end, in order.
        submit(&handle, "decline this", None).await;
        wait_for_log(
            &trace,
            &[
                "prompt:hold one",
                "steer:also this",
                "steer:and that",
                "declined:decline this",
            ],
        )
        .await;
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        assert_eq!(handle.get_queue()[0].text, "decline this");

        // Stopping sends what is queued as a turn of its own, never into the
        // turn that is being stopped.
        handle.cancel().await.unwrap();
        submit(&handle, "after stop", None).await;
        wait_for_user(&mut events, "decline this").await;
        wait_for_user(&mut events, "after stop").await;
        wait_for_log(
            &trace,
            &[
                "prompt:hold one",
                "steer:also this",
                "steer:and that",
                "declined:decline this",
                "prompt:decline this",
                "prompt:after stop",
            ],
        )
        .await;
        handle.request_shutdown();
    }

    #[tokio::test]
    async fn v1_commands_and_other_senders_are_not_steered() {
        let _lock = crate::storage::database::test_lock().lock().await;
        let dir = tempfile::tempdir().unwrap();
        crate::storage::set_grove_dir_override(Some(dir.path().to_path_buf()));
        let _reset = Reset;
        for (text, sender) in [("/compact", None), ("from an agent", Some("agent:other"))] {
            let (handle, _events, trace) = start(dir.path(), 1).await;
            let _ = std::fs::remove_file(&trace);
            handle
                .send_prompt("hold".into(), Vec::new(), None, false, None)
                .await
                .unwrap();
            wait_for_log(&trace, &["prompt:hold"]).await;
            submit(&handle, text, sender).await;
            // A later message does not overtake it.
            submit(&handle, "behind it", None).await;
            tokio::time::sleep(std::time::Duration::from_millis(200)).await;
            wait_for_log(&trace, &["prompt:hold"]).await;
            assert_eq!(handle.get_queue().len(), 2, "{text}");
            handle.request_shutdown();
        }
    }

    #[tokio::test]
    async fn v2_messages_join_the_running_turn_as_prompts() {
        let _lock = crate::storage::database::test_lock().lock().await;
        let dir = tempfile::tempdir().unwrap();
        crate::storage::set_grove_dir_override(Some(dir.path().to_path_buf()));
        let _reset = Reset;
        let (handle, mut events, trace) = start(dir.path(), 2).await;
        handle
            .send_prompt("one".into(), Vec::new(), None, false, None)
            .await
            .unwrap();
        wait_for_log(&trace, &["prompt:one"]).await;
        wait(&mut events, |event| {
            matches!(event, AcpUpdate::V2MessageBind { message_id, .. } if message_id == "u1")
        })
        .await;
        submit(&handle, "finish it", None).await;
        wait_for_user(&mut events, "finish it").await;
        wait(&mut events, |event| {
            matches!(event, AcpUpdate::V2MessageBind { message_id, .. } if message_id == "u2")
        })
        .await;
        wait_for_log(&trace, &["prompt:one", "steer:finish it"]).await;
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        assert!(!handle.is_busy.load(Ordering::Relaxed));
        assert!(handle.get_queue().is_empty());
        handle.request_shutdown();
    }
}

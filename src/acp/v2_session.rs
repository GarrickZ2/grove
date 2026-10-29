//! ACP v2 connection and foreground-session lifecycle.

use std::sync::Arc;

use agent_client_protocol::{schema::v2, Agent, V2ConnectionTo};
use futures::{AsyncRead, AsyncWrite};
use tokio::sync::mpsc;

use super::{acp, v2_permissions, v2_wire, AcpClientState, AcpCommand, AcpStartConfig};

/// Establish a v2 connection with the same transport Grove uses for v1.
pub async fn run<W, R>(
    transport: acp::ByteStreams<W, R>,
    state: Arc<AcpClientState>,
    config: AcpStartConfig,
    commands: Arc<tokio::sync::Mutex<mpsc::Receiver<AcpCommand>>>,
) -> acp::Result<()>
where
    W: AsyncWrite + Unpin + Send + 'static,
    R: AsyncRead + Unpin + Send + 'static,
{
    let (updates_tx, updates_rx) = mpsc::unbounded_channel();
    acp::Client
        .v2()
        .on_receive_notification(
            async move |update: v2::UpdateSessionNotification, _connection| {
                updates_tx
                    .send(update)
                    .map_err(acp::Error::into_internal_error)
            },
            agent_client_protocol::on_receive_notification!(),
        )
        .on_receive_request(
            {
                let state = Arc::clone(&state);
                async move |request: v2::RequestPermissionRequest, responder, cx| {
                    let origin = state.handle.active_turn_origin();
                    let child_cancel = state
                        .handle
                        .child_cancellation(&request.session_id.to_string());
                    let state = Arc::clone(&state);
                    cx.spawn(async move {
                        let cancellation = responder.cancellation();
                        match v2_permissions::request(
                            &state,
                            request,
                            cancellation,
                            origin,
                            child_cancel,
                        )
                        .await
                        {
                            Ok(response) => responder.respond(response),
                            Err(error) => responder.respond_with_error(error),
                        }
                    })?;
                    Ok(())
                }
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            {
                let state = Arc::clone(&state);
                async move |request: v2::CreateElicitationRequest, responder, cx| {
                    let origin = state.handle.active_turn_origin();
                    let state = Arc::clone(&state);
                    cx.spawn(async move {
                        let cancellation = responder.cancellation();
                        let result: acp::Result<v2::CreateElicitationResponse> = async {
                            let raw = serde_json::to_value(request)
                                .map_err(acp::Error::into_internal_error)?;
                            let request: acp::CreateElicitationRequest =
                                serde_json::from_value(raw)
                                    .map_err(acp::Error::into_internal_error)?;
                            let child_cancel = match request.scope() {
                                acp::ElicitationScope::Session(scope) => state
                                    .handle
                                    .child_cancellation(&scope.session_id.to_string()),
                                _ => Default::default(),
                            };
                            let response = super::handle_create_elicitation(
                                &state,
                                request,
                                cancellation,
                                origin,
                                child_cancel,
                            )
                            .await?;
                            serde_json::from_value(
                                serde_json::to_value(response)
                                    .map_err(acp::Error::into_internal_error)?,
                            )
                            .map_err(acp::Error::into_internal_error)
                        }
                        .await;
                        match result {
                            Ok(response) => responder.respond(response),
                            Err(error) => responder.respond_with_error(error),
                        }
                    })?;
                    Ok(())
                }
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_notification(
            {
                let state = Arc::clone(&state);
                async move |notification: v2::CompleteElicitationNotification, _cx| {
                    let raw = serde_json::to_value(notification)
                        .map_err(acp::Error::into_internal_error)?;
                    let notification =
                        serde_json::from_value(raw).map_err(acp::Error::into_internal_error)?;
                    super::handle_complete_elicitation(&state, notification)
                }
            },
            agent_client_protocol::on_receive_notification!(),
        )
        .connect_with(
            transport,
            move |connection: V2ConnectionTo<Agent>| async move {
                *state.handle.subagent_connection_v2.lock().unwrap() = Some(connection.clone());
                let mut commands = commands.lock().await;
                let result =
                    drive(connection, state.clone(), config, &mut commands, updates_rx).await;
                *state.handle.subagent_connection_v2.lock().unwrap() = None;
                result
            },
        )
        .await
}

async fn drive(
    connection: V2ConnectionTo<Agent>,
    state: Arc<AcpClientState>,
    config: AcpStartConfig,
    commands: &mut mpsc::Receiver<AcpCommand>,
    mut updates: mpsc::UnboundedReceiver<v2::UpdateSessionNotification>,
) -> acp::Result<()> {
    state.handle.emit(super::AcpUpdate::ConnectPhase {
        phase: "initialize".into(),
    });
    let initialized = v2_wire::initialize(&connection, config.agent_type != "remote").await?;
    let capabilities = initialized
        .capabilities
        .session
        .as_ref()
        .ok_or_else(|| acp::Error::invalid_params().data("Agent does not support sessions"))?;
    let agent_name = initialized
        .info
        .title
        .clone()
        .unwrap_or_else(|| initialized.info.name.clone());
    let agent_version = initialized.info.version.clone();
    let auth_methods = auth_methods(&initialized.auth_methods, config.agent_type != "remote");
    *state.handle.auth_methods.lock().unwrap() = auth_methods.clone();
    state.handle.logout_capable.store(
        !initialized.auth_methods.is_empty(),
        std::sync::atomic::Ordering::Relaxed,
    );
    let token = config.env_vars.get("GROVE_MCP_TOKEN").map(String::as_str);
    // Build direct HTTP descriptions where applicable; v2 never asks Grove to
    // provide a transport the Agent has not advertised.
    let stdio = capabilities
        .mcp
        .as_ref()
        .is_some_and(|mcp| mcp.stdio.is_some());
    let http = capabilities
        .mcp
        .as_ref()
        .is_some_and(|mcp| mcp.http.is_some());
    let configured = if stdio || http {
        super::build_mcp_servers_filtered(
            &config.env_vars,
            token,
            true,
            &config.additional_mcp_servers,
            config.mcp_server_policy,
            Some((stdio, http)),
            &state.handle.mcp_warnings,
        )
        .await
        .map_err(acp::Error::into_internal_error)?
    } else {
        Vec::new()
    };
    let servers = v2_wire::mcp_servers(configured, capabilities.mcp.as_ref())?;
    let saved_id = match config.chat_id.as_ref() {
        Some(chat_id) => {
            crate::storage::tasks::get_chat_session(&config.project_key, &config.task_id, chat_id)
                .map_err(acp::Error::into_internal_error)?
                .and_then(|chat| chat.acp_session_id)
        }
        None => None,
    };
    let directories = if capabilities.additional_directories.is_some() {
        super::resolve_linked_project_paths(&config.project_key, &config.task_id)
            .map_err(acp::Error::into_internal_error)?
    } else {
        Vec::new()
    };
    let system_prompt = if capabilities.system_prompt.is_some() {
        let available = servers.iter().any(
            |server| matches!(server, v2::McpServer::Http(server) if server.name == "grove_agent"),
        );
        super::session_bootstrap_instruction(&config, available).map(|(_, instruction)| {
            v2::SystemPrompt::new(vec![v2::ContentBlock::Text(v2::TextContent::new(
                instruction,
            ))])
        })
    } else {
        None
    };
    let opened = loop {
        let phase = if saved_id.is_some() {
            "session/resume"
        } else {
            "session/new"
        };
        state.handle.emit(super::AcpUpdate::ConnectPhase {
            phase: phase.into(),
        });
        match v2_wire::open_session(
            &connection,
            config.working_dir.clone(),
            saved_id.clone(),
            config.import_session,
            servers.clone(),
            directories.clone(),
            system_prompt.clone(),
        )
        .await
        {
            Ok(opened) => break opened,
            Err(error) if i32::from(error.code) == -32000 => {
                *state.handle.pending_auth.lock().unwrap() = Some(super::PendingAuthState {
                    methods: auth_methods.clone(),
                    agent_name: Some(agent_name.clone()),
                });
                state.handle.emit(super::AcpUpdate::AuthRequired {
                    methods: auth_methods.clone(),
                    agent_name: Some(agent_name.clone()),
                });
                if !await_start_auth(&connection, &state, commands).await? {
                    return Ok(());
                }
            }
            Err(error) => return Err(error),
        }
    };
    *state.handle.pending_auth.lock().unwrap() = None;
    if let Some(chat_id) = &config.chat_id {
        crate::storage::tasks::update_chat_acp_session_id(
            &config.project_key,
            &config.task_id,
            chat_id,
            &opened.id.to_string(),
        )
        .map_err(acp::Error::into_internal_error)?;
    }
    state.handle.set_session_restore_capabilities(false, true);
    let options = super::v2_config::options(&opened.config_options);
    let (modes, current_mode, _, mode_descriptions) = super::extract_modes(&None, &options, true);
    let (models, current_model, model_config_id) = super::extract_config_select(
        &options,
        acp::SessionConfigOptionCategory::Model,
        &["model"],
    );
    let (thoughts, current_thought, thought_config_id) = super::extract_thought_level(&options);
    *state.handle.current_config_options.lock().unwrap() = options.clone();
    *state.handle.current_mode_id.lock().unwrap() = current_mode.clone();
    *state.handle.current_model_id.lock().unwrap() = current_model.clone();
    *state.handle.model_config_id.lock().unwrap() = model_config_id;
    *state.handle.current_thought_level_id.lock().unwrap() = current_thought.clone();
    *state.handle.thought_level_config_id.lock().unwrap() = thought_config_id.clone();
    state
        .handle
        .uses_config_options
        .store(true, std::sync::atomic::Ordering::Relaxed);
    *state.handle.agent_info.write().unwrap() = Some((
        opened.id.to_string(),
        agent_name.clone(),
        agent_version.clone(),
    ));
    let prompt = capabilities.prompt.as_ref();
    let prompt_capabilities = super::PromptCapabilitiesData {
        image: prompt.is_some_and(|prompt| prompt.image.is_some()),
        audio: prompt.is_some_and(|prompt| prompt.audio.is_some()),
        embedded_context: prompt.is_some_and(|prompt| prompt.embedded_context.is_some()),
    };
    let fork_capable = capabilities.fork.is_some();
    let delete_capable = capabilities.delete.is_some();
    state
        .handle
        .fork_capable
        .store(fork_capable, std::sync::atomic::Ordering::Relaxed);
    state
        .handle
        .import_capable
        .store(true, std::sync::atomic::Ordering::Relaxed);
    state
        .handle
        .delete_capable
        .store(delete_capable, std::sync::atomic::Ordering::Relaxed);
    state
        .handle
        .close_capable
        .store(true, std::sync::atomic::Ordering::Relaxed);
    // Resume sends its current state before its response. Consume that state
    // before accepting commands, while preserving replay events in order.
    let mut foreground = super::v2_state::Foreground::default();
    let mut pending_updates = std::collections::VecDeque::new();
    let mut saw_resume_state = false;
    while let Ok(notification) = updates.try_recv() {
        if notification.session_id == opened.id {
            if let v2::SessionUpdate::StateUpdate(update) = &notification.update {
                foreground.apply(update);
                saw_resume_state = true;
                continue;
            }
        }
        pending_updates.push_back(notification);
    }
    if saved_id.is_some() && !saw_resume_state {
        async {
            loop {
                let notification = updates.recv().await.ok_or_else(|| {
                    acp::Error::internal_error().data("Session ended before its resume state")
                })?;
                if notification.session_id == opened.id {
                    if let v2::SessionUpdate::StateUpdate(update) = &notification.update {
                        foreground.apply(update);
                        break Ok::<(), acp::Error>(());
                    }
                }
                pending_updates.push_back(notification);
            }
        }
        .await?;
    }
    state.handle.emit(super::AcpUpdate::SessionReady {
        session_id: opened.id.to_string(),
        protocol_version: Some(2),
        agent_name,
        agent_version,
        mcp_warnings: state.handle.mcp_warnings.lock().unwrap().clone(),
        available_modes: modes,
        mode_descriptions,
        current_mode_id: current_mode,
        available_models: models,
        current_model_id: current_model,
        available_thought_levels: thoughts,
        current_thought_level_id: current_thought,
        thought_level_config_id: thought_config_id,
        config_options: options,
        uses_config_options: true,
        prompt_capabilities: prompt_capabilities.clone(),
        fork_capable,
        import_capable: true,
        delete_capable,
        auth_methods,
        logout_capable: !initialized.auth_methods.is_empty(),
    });
    if foreground.is_active() {
        state.handle.emit(super::AcpUpdate::Busy { value: true });
    }
    state.handle.finish_terminal_auth_reconnect();
    emit_commands(&state, opened.commands.clone());
    let (prompt_tx, mut prompt_rx) = mpsc::unbounded_channel::<acp::Result<v2::PromptResponse>>();
    let mut turn: Option<Turn> = None;
    let mut terminals = super::v2_terminal::Terminals::default();
    let mut child_terminals =
        std::collections::HashMap::<String, super::v2_terminal::Terminals>::new();
    let mut messages = super::v2_messages::Messages::default();
    let mut tools = super::v2_tools::Tools::default();
    let mut accepted_user_messages = std::collections::HashSet::new();
    loop {
        let can_take_command = pending_updates.is_empty();
        tokio::select! {
            notification = async {
                match pending_updates.pop_front() {
                    Some(update) => Some(update),
                    None => updates.recv().await,
                }
            } => {
                let Some(notification) = notification else { break };
                let session = notification.session_id.to_string();
                if notification.session_id != opened.id {
                    if state.handle.is_subagent(&session) {
                        let terminals = child_terminals.entry(session.clone()).or_default();
                        handle_child_update(&state, &session, notification.update, terminals);
                    }
                    continue;
                }
                match notification.update {
                    v2::SessionUpdate::StateUpdate(update) => {
                        match foreground.apply(&update) {
                            super::v2_state::Transition::Active | super::v2_state::Transition::Waiting => {
                                if !state.handle.is_busy.load(std::sync::atomic::Ordering::Relaxed) {
                                    state.handle.emit(super::AcpUpdate::Busy { value: true });
                                }
                            }
                            super::v2_state::Transition::Completed(idle) => {
                                for terminal in terminals.values() { emit_terminal(&state, terminal, true); }
                                for (session, child) in &child_terminals { for terminal in child.values() { state.handle.emit_child(session, terminal_event(terminal, true)); } }
                                if let Some(turn) = turn.as_mut() {
                                    turn.idle = Some(idle);
                                } else {
                                    state.handle.emit(super::AcpUpdate::Busy { value: false });
                                    let cost = state.handle.current_usage.lock().unwrap().as_ref().and_then(|usage| usage.cost.clone());
                                    state.handle.emit(super::AcpUpdate::Complete {
                                        stop_reason: stop_reason(&idle),
                                        usage: idle.usage.map(|usage| turn_usage(*usage)),
                                        start_ts: None,
                                        end_ts: Some(chrono::Utc::now().timestamp()),
                                        cost,
                                    });
                                    state.handle.drain_queue_if_ready();
                                }
                            }
                            super::v2_state::Transition::Unchanged => {}
                        }
                    }
                    update @ (v2::SessionUpdate::UserMessage(_) | v2::SessionUpdate::UserMessageChunk(_)) => {
                        let message_id = match &update {
                            v2::SessionUpdate::UserMessage(message) => message.message_id.to_string(),
                            v2::SessionUpdate::UserMessageChunk(message) => message.message_id.to_string(),
                            _ => unreachable!(),
                        };
                        if accepted_user_messages.contains(&message_id) {
                            state.handle.emit(super::AcpUpdate::V2MessageUpdate { update });
                        } else if let Some(turn) = turn.as_mut() {
                            if !turn.accepted { turn.user_updates.push(update); }
                        } else if config.import_session {
                            state.handle.emit(super::AcpUpdate::V2MessageUpdate { update });
                        }
                    }
                    v2::SessionUpdate::TerminalUpdate(update) => {
                        match terminals.update(update) {
                            Ok(terminal) => { emit_terminal(&state, terminal, false); },
                            Err(error) => state.handle.emit(super::AcpUpdate::Error { message: format!("Invalid terminal output: {error}") }),
                        }
                    }
                    v2::SessionUpdate::TerminalOutputChunk(chunk) => {
                        match terminals.chunk(&chunk) {
                            Ok(terminal) => { emit_terminal(&state, terminal, false); },
                            Err(error) => state.handle.emit(super::AcpUpdate::Error { message: format!("Invalid terminal output: {error}") }),
                        }
                    }
                    update => {
                        let is_tool = matches!(&update, v2::SessionUpdate::ToolCallUpdate(_) | v2::SessionUpdate::ToolCallContentChunk(_));
                        handle_update(&state, update, &mut messages, &mut tools);
                        if is_tool { for terminal in terminals.values() { emit_terminal(&state, terminal, false); } }
                    },
                }
            }
            response = prompt_rx.recv(), if turn.is_some() => {
                let Some(response) = response else { break };
                if let Some(active) = turn.as_mut() {
                    match response {
                        Ok(response) => {
                            active.accepted = true;
                            if let Some(revision) = active.instruction_revision.take() {
                                state.handle.clear_pending_session_instruction(revision);
                            }
                            accepted_user_messages.insert(response.message_id.to_string());
                            state.handle.emit(super::AcpUpdate::V2MessageBind {
                                client_message_id: active.local_message_id.clone(), message_id: response.message_id.to_string(),
                            });
                            for update in active.user_updates.drain(..) {
                                state.handle.emit(super::AcpUpdate::V2MessageUpdate { update });
                            }
                        }
                        Err(error) => {
                            state.handle.emit(super::AcpUpdate::Busy { value: foreground.is_active() });
                            state.handle.emit(super::AcpUpdate::TurnInterrupted { start_ts: active.start, end_ts: chrono::Utc::now().timestamp(), usage: None });
                            state.handle.emit(super::AcpUpdate::PromptFailed { message_ids: active.message_ids.clone(), message: error.to_string() });
                            if i32::from(error.code) == -32000 {
                                *state.handle.pending_auth_retry.lock().unwrap() = Some(active.retry.clone());
                                let methods = state.handle.auth_methods.lock().unwrap().clone();
                                let agent_name = state.handle.agent_info.read().unwrap().as_ref().map(|(_, name, _)| name.clone());
                                *state.handle.pending_auth.lock().unwrap() = Some(super::PendingAuthState { methods: methods.clone(), agent_name: agent_name.clone() });
                                state.handle.emit(super::AcpUpdate::AuthRequired { methods, agent_name });
                            } else {
                                state.handle.emit(super::AcpUpdate::Error { message: error.to_string() });
                            }
                            turn = None;
                            if !foreground.is_active() { state.handle.drain_queue_if_ready(); }
                        }
                    }
                }
            }
            command = state.handle.next_command(commands), if can_take_command => {
                let Some(command) = command else { break };
                match command {
                    AcpCommand::Kill => {
                        if let Some(active) = turn.take() {
                            state.handle.emit(super::AcpUpdate::TurnInterrupted { start_ts: active.start, end_ts: chrono::Utc::now().timestamp(), usage: None });
                        }
                        break;
                    },
                    AcpCommand::Cancel => {
                        state.handle.cancel_current_turn_state();
                        connection.send_notification(v2::CancelSessionNotification::new(opened.id.clone()))?;
                    }
                    AcpCommand::Prompt { message_ids, source_text, mut text, attachments, sender, terminal, config: prompt_config } => {
                        if turn.is_some() || foreground.is_active() || state.handle.terminal_auth_in_progress() {
                            let mut queued = super::QueuedMessage::new(source_text, attachments, sender, terminal, prompt_config).with_processed_text(text);
                            queued.message_ids = message_ids;
                            state.handle.pending_queue.lock().unwrap().push(queued);
                            state.handle.emit(super::AcpUpdate::QueueUpdate { messages: state.handle.get_queue() });
                            continue;
                        }
                        if let Err(message) = super::validate_prompt_content(&prompt_capabilities, &attachments) {
                            state.handle.reject_prompt_before_start(message_ids, message, false);
                            continue;
                        }
                        let is_retry = state.handle.take_middleware_dispatched_retry(&message_ids);
                        if !is_retry {
                            text = match crate::plugins::prompt_middleware::run(
                                crate::plugins::prompt_middleware::Phase::Dispatch, &state.handle.project_key,
                                &state.handle.task_id, state.handle.chat_id.as_deref(), &message_ids, text, sender.as_deref(),
                            ).await {
                                Ok(text) => text,
                                Err(error) => { state.handle.reject_prompt_before_start(message_ids, error.to_string(), true); continue; }
                            };
                        }
                        if let Some(prompt_config) = &prompt_config {
                            if let Err(error) = apply_prompt_config(&connection, &state, &opened.id, prompt_config).await {
                                state.handle.reject_prompt_before_start(message_ids, error, false);
                                continue;
                            }
                        }
                        let retry = (message_ids.clone(), source_text, text.clone(), attachments.clone(), sender.clone(), terminal, prompt_config.clone());
                        state.handle.cancel_requested.store(false, std::sync::atomic::Ordering::Relaxed);
                        state.handle.active_tool_calls.lock().unwrap().clear();
                        messages = super::v2_messages::Messages::default();
                        let dynamic = state.handle.pending_session_instruction_snapshot();
                        let wire_text = match &dynamic {
                            Some((_, kind, instruction)) => crate::agent_graph::inject::build_session_instruction_prompt(kind, instruction, &text),
                            None => text.clone(),
                        };
                        let mut content = vec![v2::ContentBlock::Text(v2::TextContent::new(wire_text.clone()))];
                        for attachment in &attachments {
                            let raw = serde_json::to_value(super::to_acp_content_block(attachment)).map_err(acp::Error::into_internal_error)?;
                            content.push(serde_json::from_value(raw).map_err(acp::Error::into_internal_error)?);
                        }
                        state.handle.emit(super::AcpUpdate::PromptStarted { message_ids: message_ids.clone() });
                        let local_message_id = if message_ids.len() == 1 { message_ids[0].clone() } else { format!("v2-{}", message_ids.first().cloned().unwrap_or_else(|| uuid::Uuid::new_v4().to_string())) };
                        if !is_retry {
                            state.handle.emit(super::AcpUpdate::UserMessage { message_id: None, client_message_id: Some(local_message_id.clone()), text: wire_text, attachments, sender, terminal });
                            state.handle.emit_user_message_time(&message_ids, Some(local_message_id.clone()));
                        }
                        *state.handle.last_user_prompt.lock().unwrap() = Some(text);
                        state.handle.emit(super::AcpUpdate::Busy { value: true });
                        let automation_run_id = config.chat_id.as_deref().and_then(|chat_id| crate::storage::automations::nonterminal_run_id_for_chat(&config.project_key, &config.task_id, chat_id).ok().flatten());
                        turn = Some(Turn { message_ids, local_message_id, accepted: false, idle: None, user_updates: Vec::new(), start: chrono::Utc::now().timestamp(), automation_run_id, instruction_revision: dynamic.map(|(revision, _, _)| revision), retry });
                        let conn = connection.clone();
                        let id = opened.id.clone();
                        let tx = prompt_tx.clone();
                        tokio::task::spawn_local(async move {
                            let response = conn.send_request(v2::PromptRequest::new(id, content)).block_task().await;
                            let _ = tx.send(response);
                        });
                    }
                    other => handle_command(&connection, &state, &config, &opened.id, &servers, &directories, &system_prompt, other).await,
                }
            }
        }
        if turn
            .as_ref()
            .is_some_and(|turn| turn.accepted && turn.idle.is_some())
        {
            let finished = turn.take().unwrap();
            finish_turn(&state, &config, finished);
        }
    }
    if let Some(active) = turn.take() {
        state.handle.emit(super::AcpUpdate::TurnInterrupted {
            start_ts: active.start,
            end_ts: chrono::Utc::now().timestamp(),
            usage: None,
        });
    }
    for terminal in terminals.values() {
        emit_terminal(&state, terminal, true);
    }
    for (session, child) in &child_terminals {
        for terminal in child.values() {
            state
                .handle
                .emit_child(session, terminal_event(terminal, true));
        }
    }
    let _ = tokio::time::timeout(
        std::time::Duration::from_secs(3),
        connection
            .send_request(v2::CloseSessionRequest::new(opened.id))
            .block_task(),
    )
    .await;
    Ok(())
}

#[allow(clippy::too_many_arguments)]
async fn handle_command(
    connection: &V2ConnectionTo<Agent>,
    state: &AcpClientState,
    config: &AcpStartConfig,
    session_id: &v2::SessionId,
    servers: &[v2::McpServer],
    directories: &[std::path::PathBuf],
    system_prompt: &Option<v2::SystemPrompt>,
    command: AcpCommand,
) {
    match command {
        AcpCommand::SetMode { mode_id, reply } => {
            let options = state.handle.current_config_options.lock().unwrap().clone();
            let (_, _, id, _) = super::extract_modes(&None, &options, true);
            let result = match id {
                Some(id) => {
                    set_option(
                        connection,
                        state,
                        session_id,
                        id,
                        super::ConfigOptionValue::Select(mode_id),
                    )
                    .await
                }
                None => Err("Agent does not advertise a mode option".into()),
            };
            let _ = reply.send(result);
        }
        AcpCommand::SetConfigOption {
            config_id,
            value,
            reply,
        } => {
            let result = set_option(connection, state, session_id, config_id, value).await;
            let _ = reply.send(result);
        }
        AcpCommand::ListSessions { cursor, reply } => {
            let request = v2::ListSessionsRequest::new()
                .cwd(v2::AbsolutePath::new(config.working_dir.clone()))
                .cursor(cursor.map(v2::SessionListCursor::new));
            let result = connection
                .send_request(request)
                .block_task()
                .await
                .map(|response| super::SessionListPage {
                    sessions: response
                        .sessions
                        .into_iter()
                        .map(|item| super::ListedSession {
                            session_id: item.session_id.to_string(),
                            cwd: item.cwd.0.to_string_lossy().into_owned(),
                            title: item.title,
                            updated_at: item.updated_at,
                        })
                        .collect(),
                    next_cursor: response.next_cursor.map(|cursor| cursor.to_string()),
                })
                .map_err(|error| error.to_string());
            let _ = reply.send(result);
        }
        AcpCommand::DeleteSession { reply } => {
            if !state
                .handle
                .delete_capable
                .load(std::sync::atomic::Ordering::Relaxed)
            {
                let _ = reply.send(Err("Unsupported".into()));
                return;
            }
            let result = connection
                .send_request(v2::DeleteSessionRequest::new(session_id.clone()))
                .block_task()
                .await
                .map(|_| ())
                .map_err(|error| error.to_string());
            let _ = reply.send(result);
        }
        AcpCommand::ForkSession { cwd, reply } => {
            if !state
                .handle
                .fork_capable
                .load(std::sync::atomic::Ordering::Relaxed)
            {
                let _ = reply.send(Err("Unsupported".into()));
                return;
            }
            let request = v2::ForkSessionRequest::new(session_id.clone(), cwd)
                .mcp_servers(servers.to_vec())
                .additional_directories(directories.to_vec())
                .system_prompt(system_prompt.clone());
            let result = connection
                .send_request(request)
                .block_task()
                .await
                .map(|response| response.session_id.to_string())
                .map_err(|error| error.to_string());
            let _ = reply.send(result);
        }
        AcpCommand::Logout { reply } => {
            if !state
                .handle
                .logout_capable
                .load(std::sync::atomic::Ordering::Relaxed)
            {
                let _ = reply.send(Err("Unsupported".into()));
                return;
            }
            let result = connection
                .send_request(v2::LogoutAuthRequest::new())
                .block_task()
                .await
                .map(|_| ())
                .map_err(|error| error.to_string());
            if result.is_ok() {
                state.handle.emit(super::AcpUpdate::AuthLoggedOut);
            }
            let _ = reply.send(result);
        }
        AcpCommand::Authenticate { method_id } => {
            if !state
                .handle
                .auth_methods
                .lock()
                .unwrap()
                .iter()
                .any(|method| method.id == method_id && method.kind == super::AuthMethodKind::Agent)
            {
                return;
            }
            match connection
                .send_request(v2::LoginAuthRequest::new(method_id))
                .block_task()
                .await
            {
                Ok(_) => {
                    *state.handle.pending_auth.lock().unwrap() = None;
                    state.handle.emit(super::AcpUpdate::AuthSucceeded);
                    let retry = state.handle.pending_auth_retry.lock().unwrap().take();
                    if let Some(retry) = retry {
                        state.handle.retry_prompt_after_auth(retry);
                    }
                }
                Err(error) => state.handle.emit(super::AcpUpdate::AuthFailed {
                    message: error.to_string(),
                }),
            }
        }
        AcpCommand::RetryAuthentication => {
            if let Some(retry) = state.handle.pending_auth_retry.lock().unwrap().take() {
                state.handle.retry_prompt_after_auth(retry);
            }
        }
        AcpCommand::Prompt { .. } | AcpCommand::Cancel | AcpCommand::Kill => unreachable!(),
    }
}

fn auth_methods(methods: &[v2::AuthMethod], local: bool) -> Vec<super::AuthMethodInfo> {
    methods
        .iter()
        .filter_map(|method| {
            let (kind, terminal) = match method {
                v2::AuthMethod::Agent(_) => (super::AuthMethodKind::Agent, None),
                v2::AuthMethod::Terminal(terminal) if local => {
                    let env = terminal
                        .env
                        .iter()
                        .map(|item| (item.name.clone(), item.value.clone()))
                        .collect();
                    let converted = acp::AuthMethodTerminal::new(
                        terminal.method_id.to_string(),
                        terminal.name.clone(),
                    )
                    .args(terminal.args.clone())
                    .env(env)
                    .description(terminal.description.clone())
                    .meta(terminal.meta.clone());
                    (super::AuthMethodKind::Terminal, Some(converted))
                }
                _ => return None,
            };
            Some(super::AuthMethodInfo {
                kind,
                terminal,
                id: method.method_id().to_string(),
                name: method.name().to_string(),
                description: method.description().map(str::to_owned),
            })
        })
        .collect()
}

async fn await_start_auth(
    connection: &V2ConnectionTo<Agent>,
    state: &AcpClientState,
    commands: &mut mpsc::Receiver<AcpCommand>,
) -> acp::Result<bool> {
    while let Some(command) = commands.recv().await {
        match command {
            AcpCommand::Authenticate { method_id } => {
                let allowed = state
                    .handle
                    .auth_methods
                    .lock()
                    .unwrap()
                    .iter()
                    .any(|method| {
                        method.id == method_id && method.kind == super::AuthMethodKind::Agent
                    });
                if !allowed {
                    continue;
                }
                match connection
                    .send_request(v2::LoginAuthRequest::new(method_id))
                    .block_task()
                    .await
                {
                    Ok(_) => {
                        state.handle.emit(super::AcpUpdate::AuthSucceeded);
                        return Ok(true);
                    }
                    Err(error) => state.handle.emit(super::AcpUpdate::AuthFailed {
                        message: error.to_string(),
                    }),
                }
            }
            AcpCommand::RetryAuthentication => return Ok(true),
            AcpCommand::Kill => return Ok(false),
            AcpCommand::Prompt {
                message_ids,
                source_text,
                text,
                attachments,
                sender,
                terminal,
                config,
            } => {
                let mut queued =
                    super::QueuedMessage::new(source_text, attachments, sender, terminal, config)
                        .with_processed_text(text);
                queued.message_ids = message_ids;
                state.handle.pending_queue.lock().unwrap().push(queued);
                state.handle.emit(super::AcpUpdate::QueueUpdate {
                    messages: state.handle.get_queue(),
                });
            }
            AcpCommand::ForkSession { reply, .. } => {
                let _ = reply.send(Err("Authentication required".into()));
            }
            AcpCommand::DeleteSession { reply }
            | AcpCommand::Logout { reply }
            | AcpCommand::SetMode { reply, .. }
            | AcpCommand::SetConfigOption { reply, .. } => {
                let _ = reply.send(Err("Authentication required".into()));
            }
            AcpCommand::ListSessions { reply, .. } => {
                let _ = reply.send(Err("Authentication required".into()));
            }
            AcpCommand::Cancel => {}
        }
    }
    Ok(false)
}

async fn set_option(
    connection: &V2ConnectionTo<Agent>,
    state: &AcpClientState,
    session_id: &v2::SessionId,
    config_id: String,
    value: super::ConfigOptionValue,
) -> Result<(), String> {
    super::validated_config_request_value(&state.handle, &config_id, value.clone())?;
    let value = match value {
        super::ConfigOptionValue::Select(value) => v2::SessionConfigOptionValue::id(value),
        super::ConfigOptionValue::Boolean(value) => v2::SessionConfigOptionValue::boolean(value),
    };
    let response = connection
        .send_request(v2::SetSessionConfigOptionRequest::new(
            session_id.clone(),
            config_id,
            value,
        ))
        .block_task()
        .await
        .map_err(|error| error.to_string())?;
    super::replace_config_snapshot(
        &state.handle,
        super::v2_config::options(&response.config_options),
    );
    Ok(())
}

async fn apply_prompt_config(
    connection: &V2ConnectionTo<Agent>,
    state: &AcpClientState,
    session_id: &v2::SessionId,
    config: &super::QueuedConfig,
) -> Result<(), String> {
    let advertised = state.handle.current_config_options.lock().unwrap().clone();
    let mut desired = config.config_options.clone();
    if desired.is_empty() {
        let (_, _, mode_id, _) = super::extract_modes(&None, &advertised, true);
        let (_, _, model_id) = super::extract_config_select(
            &advertised,
            acp::SessionConfigOptionCategory::Model,
            &["model"],
        );
        for (id, value) in [
            (mode_id, config.mode.clone()),
            (model_id, config.model.clone()),
            (
                config.thought_level_config_id.clone(),
                config.thought_level.clone(),
            ),
        ] {
            if let (Some(id), Some(value)) = (id, value) {
                desired.insert(id, super::ConfigOptionValue::Select(value));
            }
        }
    }
    for option in advertised {
        let id = option.id.to_string();
        let Some(value) = desired.remove(&id) else {
            continue;
        };
        if crate::agent_config::config_option_has_current_value(&option, &value) {
            continue;
        }
        if super::validated_config_request_value(&state.handle, &id, value.clone()).is_err() {
            continue;
        }
        set_option(connection, state, session_id, id, value).await?;
    }
    Ok(())
}

struct Turn {
    message_ids: Vec<String>,
    local_message_id: String,
    accepted: bool,
    idle: Option<v2::IdleStateUpdate>,
    user_updates: Vec<v2::SessionUpdate>,
    start: i64,
    automation_run_id: Option<String>,
    instruction_revision: Option<u64>,
    retry: super::PendingPromptRetry,
}

fn stop_reason(idle: &v2::IdleStateUpdate) -> String {
    match idle.stop_reason.as_ref() {
        Some(v2::StopReason::EndTurn) => "end_turn",
        Some(v2::StopReason::MaxTokens) => "max_tokens",
        Some(v2::StopReason::MaxTurnRequests) => "max_turn_requests",
        Some(v2::StopReason::Refusal) => "refusal",
        Some(v2::StopReason::Cancelled) => "cancelled",
        Some(v2::StopReason::Error(_)) => "error",
        _ => "unknown",
    }
    .to_string()
}

fn turn_usage(usage: v2::Usage) -> super::TurnUsage {
    super::TurnUsage {
        input_tokens: usage.input_tokens,
        output_tokens: usage.output_tokens,
        total_tokens: usage.total_tokens,
        cached_read_tokens: usage.cached_read_tokens,
    }
}

fn finish_turn(state: &AcpClientState, config: &AcpStartConfig, turn: Turn) {
    let idle = turn.idle.unwrap();
    let failure = match &idle.stop_reason {
        Some(v2::StopReason::Error(error)) => Some(
            error
                .error
                .as_ref()
                .map(ToString::to_string)
                .unwrap_or_else(|| "Agent work failed".into()),
        ),
        _ => None,
    };
    let reason = stop_reason(&idle);
    let usage = idle.usage.map(|usage| turn_usage(*usage));
    let cost = state
        .handle
        .current_usage
        .lock()
        .unwrap()
        .as_ref()
        .and_then(|usage| usage.cost.clone());
    let end_ts = chrono::Utc::now().timestamp();
    if let Some(usage) = usage
        .as_ref()
        .filter(|_| config.chat_id.is_some() || turn.automation_run_id.is_some())
    {
        let model = state.handle.current_model_id.lock().unwrap().clone();
        let automation_run_id = turn.automation_run_id.as_deref();
        let record = crate::storage::token_usage::TokenUsageRecord {
            project_key: &config.project_key,
            task_id: automation_run_id
                .is_none()
                .then_some(config.task_id.as_str())
                .filter(|_| config.chat_id.is_some()),
            chat_id: automation_run_id
                .is_none()
                .then_some(config.chat_id.as_deref())
                .flatten(),
            automation_run_id,
            agent: &config.agent_name,
            model: model.as_deref(),
            input_tokens: usage.input_tokens,
            cached_read_tokens: usage.cached_read_tokens,
            output_tokens: usage.output_tokens,
            total_tokens: usage.total_tokens,
            start_ts: turn.start,
            end_ts,
            cost_amount: cost.as_ref().map(|cost| cost.amount),
            cost_currency: cost.as_ref().map(|cost| cost.currency.as_str()),
        };
        if let Err(error) = crate::storage::token_usage::insert(&record) {
            eprintln!("[token_usage] insert failed: {error}");
        }
    }
    state.handle.emit(super::AcpUpdate::Busy { value: false });
    if let Some(message) = failure {
        state.handle.emit(super::AcpUpdate::TurnInterrupted {
            start_ts: turn.start,
            end_ts,
            usage,
        });
        state.handle.emit(super::AcpUpdate::PromptFailed {
            message_ids: turn.message_ids,
            message: message.clone(),
        });
        state.handle.emit(super::AcpUpdate::Error { message });
        state.handle.drain_queue_if_ready();
        return;
    }
    state.handle.emit(super::AcpUpdate::Complete {
        stop_reason: reason.clone(),
        usage,
        start_ts: Some(turn.start),
        end_ts: Some(end_ts),
        cost,
    });
    state.handle.emit(super::AcpUpdate::PromptCompleted {
        message_ids: turn.message_ids,
        stop_reason: reason,
    });
    state.handle.drain_queue_if_ready();
}

fn emit_terminal(
    state: &AcpClientState,
    terminal: &super::v2_terminal::Terminal,
    checkpoint: bool,
) {
    state.handle.emit(terminal_event(terminal, checkpoint));
}

fn terminal_event(terminal: &super::v2_terminal::Terminal, checkpoint: bool) -> super::AcpUpdate {
    let exit_status = match &terminal.state.exit_status {
        agent_client_protocol::schema::MaybeUndefined::Value(exit) => {
            Some(super::TerminalExitStatusData {
                exit_code: exit.exit_code,
                signal: exit.signal.clone(),
            })
        }
        _ => None,
    };
    super::AcpUpdate::V2TerminalOutputUpdate {
        terminal_id: terminal.state.terminal_id.to_string(),
        output: String::from_utf8_lossy(&terminal.bytes).into_owned(),
        truncated: terminal.truncated,
        exit_status,
        command: match &terminal.state.command {
            agent_client_protocol::schema::MaybeUndefined::Value(value) => Some(value.clone()),
            _ => None,
        },
        cwd: match &terminal.state.cwd {
            agent_client_protocol::schema::MaybeUndefined::Value(value) => {
                Some(value.0.to_string_lossy().into_owned())
            }
            _ => None,
        },
        checkpoint,
        meta: terminal.state.meta.clone(),
    }
}

fn handle_update(
    state: &AcpClientState,
    update: v2::SessionUpdate,
    messages: &mut super::v2_messages::Messages,
    tools: &mut super::v2_tools::Tools,
) {
    use v2::SessionUpdate;
    match update {
        SessionUpdate::AgentMessageChunk(_)
        | SessionUpdate::AgentMessage(_)
        | SessionUpdate::AgentThoughtChunk(_)
        | SessionUpdate::AgentThought(_) => {
            messages.apply(&update);
            state
                .handle
                .emit(super::AcpUpdate::V2MessageUpdate { update });
            let text = messages
                .entries()
                .iter()
                .filter(|message| message.kind == super::v2_messages::MessageKind::Agent)
                .flat_map(|message| message.content.iter())
                .filter_map(|block| match block {
                    v2::ContentBlock::Text(text) => Some(text.text.as_str()),
                    _ => None,
                })
                .collect::<Vec<_>>()
                .join("");
            *state.handle.last_turn_reply.lock().unwrap() = text.clone();
            *state.handle.last_assistant_text.lock().unwrap() = text;
        }
        SessionUpdate::ToolCallUpdate(_) | SessionUpdate::ToolCallContentChunk(_) => {
            let id = match &update {
                SessionUpdate::ToolCallUpdate(update) => update.tool_call_id.to_string(),
                SessionUpdate::ToolCallContentChunk(chunk) => chunk.tool_call_id.to_string(),
                _ => unreachable!(),
            };
            if !tools.contains(&id) {
                *messages = super::v2_messages::Messages::default();
                state.handle.last_turn_reply.lock().unwrap().clear();
            }
            match &update {
                SessionUpdate::ToolCallUpdate(patch) => {
                    let tool = tools.update(patch.clone());
                    let terminal = matches!(
                        &tool.status,
                        agent_client_protocol::schema::MaybeUndefined::Value(
                            v2::ToolCallStatus::Completed
                                | v2::ToolCallStatus::Failed
                                | v2::ToolCallStatus::Cancelled
                        )
                    );
                    let mut active = state.handle.active_tool_calls.lock().unwrap();
                    if terminal {
                        active.remove(&id);
                    } else {
                        active.insert(id.clone());
                    }
                }
                SessionUpdate::ToolCallContentChunk(chunk) => {
                    tools.chunk(chunk);
                }
                _ => unreachable!(),
            }
            state.handle.emit(super::AcpUpdate::V2ToolUpdate { update });
        }
        SessionUpdate::SubagentUpdate(update) => {
            if let Ok(update) =
                serde_json::to_value(update).and_then(serde_json::from_value::<acp::SubagentUpdate>)
            {
                let session = state
                    .handle
                    .agent_info
                    .read()
                    .unwrap()
                    .as_ref()
                    .map(|(session, _, _)| session.clone());
                if let Some(session) = session {
                    state.handle.register_subagent(&session, update);
                }
            }
        }
        SessionUpdate::SessionMessage(message) => {
            if let Ok(message) = serde_json::to_value(message)
                .and_then(serde_json::from_value::<acp::SessionMessage>)
            {
                state
                    .handle
                    .emit(super::subagents::session_message(message));
            }
        }
        SessionUpdate::SessionMessageChunk(chunk) => {
            if let Ok(chunk) = serde_json::to_value(chunk)
                .and_then(serde_json::from_value::<acp::SessionMessageChunk>)
            {
                state
                    .handle
                    .emit(super::subagents::session_message_chunk(chunk));
            }
        }
        SessionUpdate::ConfigOptionUpdate(update) => {
            super::replace_config_snapshot(
                &state.handle,
                super::v2_config::options(&update.config_options),
            );
        }
        SessionUpdate::AvailableCommandsUpdate(update) => {
            emit_commands(state, update.available_commands)
        }
        SessionUpdate::PlanUpdate(update) => {
            let plan = match update.plan {
                v2::PlanUpdateContent::Items(items) => Some(super::PlanDocument::Items {
                    plan_id: items.plan_id.to_string(),
                    entries: items
                        .entries
                        .into_iter()
                        .map(|entry| super::PlanEntryData {
                            content: entry.content,
                            priority: serde_json::to_value(entry.priority)
                                .ok()
                                .and_then(|value| value.as_str().map(str::to_owned)),
                            status: serde_json::to_value(entry.status)
                                .ok()
                                .and_then(|value| value.as_str().map(str::to_owned))
                                .unwrap_or_default(),
                        })
                        .collect(),
                }),
                v2::PlanUpdateContent::Markdown(plan) => Some(super::PlanDocument::Markdown {
                    plan_id: plan.plan_id.to_string(),
                    content: plan.content,
                }),
                v2::PlanUpdateContent::File(plan) => Some(super::PlanDocument::File {
                    plan_id: plan.plan_id.to_string(),
                    uri: plan.uri,
                }),
                _ => None,
            };
            if let Some(plan) = plan {
                state
                    .handle
                    .emit(super::AcpUpdate::PlanDocumentUpdate { plan });
            }
        }
        SessionUpdate::PlanRemoved(update) => {
            state.handle.emit(super::AcpUpdate::PlanDocumentRemoved {
                plan_id: update.plan_id.to_string(),
            })
        }
        SessionUpdate::UsageUpdate(update) => {
            let cost = update.cost.map(|cost| super::UsageCost {
                amount: cost.amount,
                currency: cost.currency,
            });
            *state.handle.current_usage.lock().unwrap() = Some(super::UsageSnapshot {
                used: update.used,
                size: update.size,
                cost: cost.clone(),
            });
            state.handle.emit(super::AcpUpdate::UsageUpdate {
                used: update.used,
                size: update.size,
                cost,
            });
        }
        SessionUpdate::Notice(notice) => {
            let severity = serde_json::to_value(notice.severity)
                .ok()
                .and_then(|value| value.as_str().map(str::to_owned))
                .unwrap_or_default();
            state.handle.emit(super::AcpUpdate::SessionNotice {
                severity,
                title: notice.title,
                description: notice.description,
            });
        }
        SessionUpdate::CompactionUpdate(update) => {
            if let Ok(update) = serde_json::to_value(update)
                .and_then(serde_json::from_value::<acp::CompactionUpdate>)
            {
                state.handle_compaction_update(update);
            }
        }
        SessionUpdate::CompactionSummaryChunk(chunk) => {
            if let Ok(chunk) = serde_json::to_value(chunk)
                .and_then(serde_json::from_value::<acp::CompactionSummaryChunk>)
            {
                state.handle_compaction_summary_chunk(chunk);
            }
        }
        SessionUpdate::SessionInfoUpdate(update) => {
            if let Ok(update) = serde_json::to_value(update)
                .and_then(serde_json::from_value::<acp::SessionInfoUpdate>)
            {
                let _ = state.handle.apply_session_info(update);
            }
        }
        other => state
            .handle
            .emit(super::AcpUpdate::V2MessageUpdate { update: other }),
    }
}

fn emit_commands(state: &AcpClientState, commands: Vec<v2::AvailableCommand>) {
    let commands = commands
        .into_iter()
        .map(|command| super::CommandInfo {
            name: command.name,
            description: command.description,
            input_hint: match command.input {
                Some(v2::AvailableCommandInput::Text(input)) => Some(input.hint),
                _ => None,
            },
        })
        .collect();
    state
        .handle
        .emit(super::AcpUpdate::AvailableCommands { commands });
}

fn handle_child_update(
    state: &AcpClientState,
    session: &str,
    update: v2::SessionUpdate,
    terminals: &mut super::v2_terminal::Terminals,
) {
    match update {
        v2::SessionUpdate::SubagentUpdate(update) => {
            if let Ok(update) =
                serde_json::to_value(update).and_then(serde_json::from_value::<acp::SubagentUpdate>)
            {
                state.handle.register_subagent(session, update);
            }
        }
        update @ (v2::SessionUpdate::AgentMessage(_)
        | v2::SessionUpdate::AgentMessageChunk(_)
        | v2::SessionUpdate::AgentThought(_)
        | v2::SessionUpdate::AgentThoughtChunk(_)
        | v2::SessionUpdate::UserMessage(_)
        | v2::SessionUpdate::UserMessageChunk(_)) => {
            state
                .handle
                .emit_child(session, super::AcpUpdate::V2MessageUpdate { update });
        }
        update @ (v2::SessionUpdate::ToolCallUpdate(_)
        | v2::SessionUpdate::ToolCallContentChunk(_)) => {
            state
                .handle
                .emit_child(session, super::AcpUpdate::V2ToolUpdate { update });
            for terminal in terminals.values() {
                state
                    .handle
                    .emit_child(session, terminal_event(terminal, false));
            }
        }
        v2::SessionUpdate::TerminalUpdate(update) => {
            if let Ok(terminal) = terminals.update(update) {
                state
                    .handle
                    .emit_child(session, terminal_event(terminal, false));
            }
        }
        v2::SessionUpdate::TerminalOutputChunk(chunk) => {
            if let Ok(terminal) = terminals.chunk(&chunk) {
                state
                    .handle
                    .emit_child(session, terminal_event(terminal, false));
            }
        }
        other => {
            if let Ok(update) =
                serde_json::to_value(&other).and_then(serde_json::from_value::<acp::SessionUpdate>)
            {
                let _ = state.handle_child_notification(acp::SessionNotification::new(
                    session.to_string(),
                    update,
                ));
            } else {
                state
                    .handle
                    .emit_child(session, super::AcpUpdate::V2MessageUpdate { update: other });
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    #[tokio::test]
    async fn v2_agent_connects_and_finishes_only_after_idle() {
        let _lock = crate::storage::database::test_lock().lock().await;
        let dir = tempfile::tempdir().unwrap();
        crate::storage::set_grove_dir_override(Some(dir.path().to_path_buf()));
        struct Reset;
        impl Drop for Reset {
            fn drop(&mut self) {
                crate::storage::set_grove_dir_override(None);
            }
        }
        let _reset = Reset;
        crate::storage::installed_agents::patch_or_create("v2-fixture", None, None, None, None)
            .unwrap();
        crate::storage::installed_agents::set_acp_protocol_version("v2-fixture", 1).unwrap();
        let invalid_mcp = crate::storage::extensions::ExtensionArtifact {
            repo_key: "invalid-repo".into(),
            repo_path: "remote".into(),
            source_name: "v2-test".into(),
            kind: "mcp".into(),
            name: "invalid".into(),
            version: None,
            description: String::new(),
            relative_path: "remote".into(),
            manifest: serde_json::json!({"name":"invalid", "remotes":[{"type":"streamable-http", "url":"http://[invalid"}]}),
        };
        crate::storage::extensions::replace_source_artifacts("v2-test", &[invalid_mcp]).unwrap();
        crate::storage::extensions::save_mcp_installations(
            "invalid-repo",
            "remote",
            "v2-test",
            "global",
            "",
            &["v2-fixture".into()],
            &serde_json::json!({"kind":"remote", "index":0}),
            &serde_json::json!({}),
        )
        .unwrap();
        let env = HashMap::from([("GROVE_AGENT_ID".into(), "v2-fixture".into())]);
        let invalid_package = crate::storage::extensions::ExtensionArtifact {
            repo_key: "invalid-package".into(),
            repo_path: "package".into(),
            source_name: "v2-package-test".into(),
            kind: "mcp".into(),
            name: "invalid-package".into(),
            version: None,
            description: String::new(),
            relative_path: "package".into(),
            manifest: serde_json::json!({"name":"invalid-package", "packages":[{"registryType":"npm"}]}),
        };
        crate::storage::extensions::replace_source_artifacts("v2-package-test", &[invalid_package])
            .unwrap();
        crate::storage::extensions::save_mcp_installations(
            "invalid-package",
            "package",
            "v2-package-test",
            "global",
            "",
            &["http-only-fixture".into()],
            &serde_json::json!({"kind":"package", "index":0}),
            &serde_json::json!({}),
        )
        .unwrap();
        let http_only_env = HashMap::from([("GROVE_AGENT_ID".into(), "http-only-fixture".into())]);
        assert!(
            super::super::load_standalone_mcp_servers(&http_only_env, true, None, None)
                .await
                .is_err()
        );
        assert!(super::super::load_standalone_mcp_servers(
            &http_only_env,
            true,
            Some((false, true)),
            None
        )
        .await
        .unwrap()
        .is_empty());
        let warnings = std::sync::Mutex::new(Vec::new());
        assert!(
            super::super::load_standalone_mcp_servers(&env, true, None, Some(&warnings))
                .await
                .unwrap()
                .is_empty()
        );
        assert_eq!(warnings.lock().unwrap()[0].name, "invalid");
        assert!(
            super::super::load_standalone_mcp_servers(&env, true, Some((true, false)), None)
                .await
                .unwrap()
                .is_empty()
        );
        let script = dir.path().join("agent.py");
        std::fs::write(&script, r#"
import json, sys
def send(msg):
    print(json.dumps(msg, separators=(',', ':')), flush=True)
def update(data):
    send({'jsonrpc':'2.0','method':'session/update','params':{'sessionId':'session-test','update':data}})
for line in sys.stdin:
    req = json.loads(line)
    method = req.get('method')
    ident = req.get('id')
    if method == 'initialize':
        if req['params']['protocolVersion'] == 1:
            send({'jsonrpc':'2.0','id':ident,'error':{'code':-32022,'message':'unsupported protocol version','data':{'requested':1,'supported':[2]}}})
        else:
            send({'jsonrpc':'2.0','id':ident,'result':{'protocolVersion':2,'info':{'name':'fixture','version':'1'},'capabilities':{'session':{'prompt':{'image':{},'audio':{}}}}}})
    elif method == 'session/new':
        assert not req['params'].get('mcpServers')
        send({'jsonrpc':'2.0','id':ident,'result':{'sessionId':'session-test'}})
    elif method == 'session/prompt':
        prompt = req['params']['prompt']
        assert [block['type'] for block in prompt] == ['text', 'image', 'audio', 'resource_link'], prompt
        assert prompt[1]['data'] == 'aW1hZ2U=' and prompt[1]['mimeType'] == 'image/png'
        assert prompt[2]['data'] == 'YXVkaW8=' and prompt[2]['mimeType'] == 'audio/wav'
        assert prompt[3]['uri'] == 'file:///tmp/report.txt' and prompt[3]['name'] == 'report.txt'
        update({'sessionUpdate':'state_update','state':'running'})
        update({'sessionUpdate':'user_message_chunk','messageId':'u1','content':{'type':'text','text':'hello'}})
        for block in prompt[1:]:
            update({'sessionUpdate':'user_message_chunk','messageId':'u1','content':block})
        update({'sessionUpdate':'agent_message_chunk','messageId':'a1','content':{'type':'text','text':'old'}})
        send({'jsonrpc':'2.0','id':ident,'result':{'messageId':'u1'}})
        update({'sessionUpdate':'agent_message','messageId':'a1','content':[{'type':'text','text':'new'}]})
        update({'sessionUpdate':'usage_update','used':12,'size':100,'cost':{'amount':0.5,'currency':'USD'}})
        update({'sessionUpdate':'state_update','state':'idle','stopReason':'end_turn','usage':{'inputTokens':8,'outputTokens':4,'totalTokens':12}})
    elif method == 'session/close':
        send({'jsonrpc':'2.0','id':ident,'result':{}})
"#).unwrap();
        let key = format!("v2-test-{}", uuid::Uuid::new_v4());
        crate::storage::tasks::add_chat_session(
            &key,
            "test",
            crate::storage::tasks::ChatSession {
                id: "usage-chat".into(),
                title: "usage".into(),
                agent: "v2-fixture".into(),
                acp_session_id: None,
                created_at: chrono::Utc::now(),
                duty: None,
                launch_mode: "acp".into(),
            },
        )
        .unwrap();
        let config = AcpStartConfig {
            agent_command: "/usr/bin/python3".into(),
            agent_name: "v2-fixture".into(),
            agent_args: vec![script.to_string_lossy().into_owned()],
            working_dir: dir.path().into(),
            env_vars: env,
            project_key: key.clone(),
            task_id: "test".into(),
            chat_id: Some("usage-chat".into()),
            artifact_dir: Some(dir.path().join("artifacts")),
            additional_mcp_servers: vec![super::super::LoopbackMcpServer {
                name: "fixture-mcp".into(),
                url: "http://127.0.0.1:1/mcp".into(),
                route: "mcp".into(),
                session_instruction: None,
            }],
            mcp_server_policy: super::super::McpServerPolicy::WorkingSession,
            agent_type: "local".into(),
            remote_url: None,
            remote_auth: None,
            suppress_initial_connecting: false,
            import_session: false,
            persona_injection: None,
        };
        let (handle, mut events) = super::super::get_or_start_session(key.clone(), config)
            .await
            .unwrap();
        struct Stop(Arc<super::super::AcpSessionHandle>);
        impl Drop for Stop {
            fn drop(&mut self) {
                self.0.request_shutdown();
            }
        }
        let _stop = Stop(handle.clone());
        tokio::time::timeout(std::time::Duration::from_secs(20), async {
            let mut sent = false;
            let mut bound = false;
            let mut recorded_cost = false;
            let mut message_updates = 0;
            loop {
                match events.recv().await.unwrap() {
                    super::super::AcpUpdate::SessionReady {
                        protocol_version, ..
                    } => {
                        assert_eq!(protocol_version, Some(2));
                        assert_eq!(
                            handle
                                .protocol_version
                                .load(std::sync::atomic::Ordering::Relaxed),
                            2
                        );
                        assert_eq!(
                            crate::storage::installed_agents::get_acp_protocol_version(
                                "v2-fixture"
                            )
                            .unwrap(),
                            1
                        );
                        handle
                            .send_tracked_prompt(
                                "hello".into(),
                                vec![
                                    super::super::ContentBlockData::Image {
                                        data: "aW1hZ2U=".into(),
                                        mime_type: "image/png".into(),
                                        uri: None,
                                        label: Some("Image #1".into()),
                                    },
                                    super::super::ContentBlockData::Audio {
                                        data: "YXVkaW8=".into(),
                                        mime_type: "audio/wav".into(),
                                        label: Some("Audio #1".into()),
                                    },
                                    super::super::ContentBlockData::ResourceLink {
                                        uri: "file:///tmp/report.txt".into(),
                                        name: "report.txt".into(),
                                        mime_type: Some("text/plain".into()),
                                        size: None,
                                        title: None,
                                        description: None,
                                        label: Some("File #1".into()),
                                    },
                                ],
                                None,
                                false,
                                None,
                            )
                            .await
                            .unwrap();
                        sent = true;
                    }
                    super::super::AcpUpdate::V2MessageBind { message_id, .. } => {
                        assert_eq!(message_id, "u1");
                        bound = true;
                    }
                    super::super::AcpUpdate::V2MessageUpdate { .. } => message_updates += 1,
                    super::super::AcpUpdate::Complete {
                        cost: Some(cost),
                        usage: Some(usage),
                        ..
                    } => {
                        assert_eq!(cost.amount, 0.5);
                        assert_eq!(usage.total_tokens, 12);
                        recorded_cost = true;
                    }
                    super::super::AcpUpdate::PromptCompleted { stop_reason, .. } => {
                        assert!(sent && bound && recorded_cost && message_updates >= 6);
                        assert_eq!(stop_reason, "end_turn");
                        break;
                    }
                    super::super::AcpUpdate::Error { message } => panic!("v2 agent: {message}"),
                    _ => {}
                }
            }
        })
        .await
        .unwrap();
        let history = crate::storage::chat_history::load_history(&key, "test", "usage-chat");
        let replayed: Vec<_> = history
            .iter()
            .filter_map(|event| match event {
                super::super::AcpUpdate::V2MessageUpdate { update } => {
                    serde_json::to_value(update).ok()
                }
                _ => None,
            })
            .filter(|event| event["sessionUpdate"] == "user_message_chunk")
            .collect();
        assert_eq!(replayed.len(), 4);
        assert_eq!(replayed[1]["content"]["data"], "aW1hZ2U=");
        assert_eq!(replayed[2]["content"]["data"], "YXVkaW8=");
        assert_eq!(replayed[3]["content"]["uri"], "file:///tmp/report.txt");
        let count: i64 = crate::storage::database::connection().query_row(
            "SELECT count(*) FROM chat_token_usage WHERE project_key = ?1 AND total_tokens = 12 AND cost_amount = 0.5",
            [key], |row| row.get(0),
        ).unwrap();
        assert_eq!(count, 1);
    }

    #[tokio::test]
    async fn resume_running_queues_new_prompt_until_existing_work_is_idle() {
        let _lock = crate::storage::database::test_lock().lock().await;
        let dir = tempfile::tempdir().unwrap();
        crate::storage::set_grove_dir_override(Some(dir.path().to_path_buf()));
        struct Reset;
        impl Drop for Reset {
            fn drop(&mut self) {
                crate::storage::set_grove_dir_override(None);
            }
        }
        let _reset = Reset;
        crate::storage::installed_agents::patch_or_create(
            "resume-v2-fixture",
            None,
            None,
            None,
            None,
        )
        .unwrap();
        crate::storage::installed_agents::set_acp_protocol_version("resume-v2-fixture", 2).unwrap();
        let key = format!("resume-v2-{}", uuid::Uuid::new_v4());
        crate::storage::tasks::add_chat_session(
            &key,
            "task",
            crate::storage::tasks::ChatSession {
                id: "chat".into(),
                title: "chat".into(),
                agent: "resume-v2-fixture".into(),
                acp_session_id: Some("old-session".into()),
                created_at: chrono::Utc::now(),
                duty: None,
                launch_mode: "acp".into(),
            },
        )
        .unwrap();
        let script = dir.path().join("agent.py");
        std::fs::write(&script, r#"
import json, sys, threading, time
ready = False
def send(msg): print(json.dumps(msg, separators=(',', ':')), flush=True)
def update(data): send({'jsonrpc':'2.0','method':'session/update','params':{'sessionId':'old-session','update':data}})
def finish_old():
    global ready
    time.sleep(.4)
    ready = True
    update({'sessionUpdate':'state_update','state':'idle','stopReason':'end_turn'})
for line in sys.stdin:
    req = json.loads(line); method = req.get('method'); ident = req.get('id')
    if method == 'initialize': send({'jsonrpc':'2.0','id':ident,'result':{'protocolVersion':2,'info':{'name':'fixture','version':'1'},'capabilities':{'session':{}}}})
    elif method == 'session/resume':
        assert req['params']['sessionId'] == 'old-session' and not req['params'].get('replayFrom')
        update({'sessionUpdate':'state_update','state':'running'})
        send({'jsonrpc':'2.0','id':ident,'result':{}})
        threading.Thread(target=finish_old, daemon=True).start()
    elif method == 'session/prompt':
        assert ready, 'prompt sent during resumed foreground work'
        update({'sessionUpdate':'state_update','state':'running'})
        send({'jsonrpc':'2.0','id':ident,'result':{'messageId':'new-user'}})
        update({'sessionUpdate':'state_update','state':'idle','stopReason':'end_turn'})
    elif method == 'session/close': send({'jsonrpc':'2.0','id':ident,'result':{}})
"#).unwrap();
        let config = AcpStartConfig {
            agent_command: "/usr/bin/python3".into(),
            agent_name: "resume-v2-fixture".into(),
            agent_args: vec![script.to_string_lossy().into_owned()],
            working_dir: dir.path().into(),
            env_vars: HashMap::new(),
            project_key: key.clone(),
            task_id: "task".into(),
            chat_id: Some("chat".into()),
            artifact_dir: Some(dir.path().join("artifacts")),
            additional_mcp_servers: Vec::new(),
            mcp_server_policy: super::super::McpServerPolicy::ExplicitOnly,
            agent_type: "local".into(),
            remote_url: None,
            remote_auth: None,
            suppress_initial_connecting: false,
            import_session: false,
            persona_injection: None,
        };
        let (handle, mut events) = super::super::get_or_start_session(key.clone(), config)
            .await
            .unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(15), async {
            let mut queued = false;
            let mut old_completed = false;
            loop {
                match events.recv().await.unwrap() {
                    super::super::AcpUpdate::SessionReady { .. } => {
                        handle
                            .send_tracked_prompt("next".into(), Vec::new(), None, false, None)
                            .await
                            .unwrap();
                    }
                    super::super::AcpUpdate::QueueUpdate { messages } if !messages.is_empty() => {
                        queued = true
                    }
                    super::super::AcpUpdate::Complete { start_ts: None, .. } => {
                        old_completed = true
                    }
                    super::super::AcpUpdate::PromptCompleted { .. } => {
                        assert!(queued && old_completed);
                        break;
                    }
                    super::super::AcpUpdate::Error { message } => panic!("resume agent: {message}"),
                    _ => {}
                }
            }
        })
        .await
        .unwrap();
        assert_eq!(
            crate::storage::tasks::get_chat_session(&key, "task", "chat")
                .unwrap()
                .unwrap()
                .acp_session_id
                .as_deref(),
            Some("old-session")
        );
        handle.request_shutdown();
    }

    #[tokio::test]
    async fn selected_v2_negotiates_v1_without_changing_the_saved_choice() {
        let _lock = crate::storage::database::test_lock().lock().await;
        let dir = tempfile::tempdir().unwrap();
        crate::storage::set_grove_dir_override(Some(dir.path().to_path_buf()));
        struct Reset;
        impl Drop for Reset {
            fn drop(&mut self) {
                crate::storage::set_grove_dir_override(None);
            }
        }
        let _reset = Reset;
        crate::storage::installed_agents::patch_or_create(
            "v1-only-fixture",
            None,
            None,
            None,
            None,
        )
        .unwrap();
        crate::storage::installed_agents::set_acp_protocol_version("v1-only-fixture", 2).unwrap();
        let script = dir.path().join("v1.py");
        let trace = dir.path().join("versions");
        std::fs::write(&script, r#"
import json, sys
for line in sys.stdin:
    request = json.loads(line); method = request.get('method'); ident = request.get('id')
    if method == 'initialize':
        with open(sys.argv[1], 'a') as f: f.write(str(request['params']['protocolVersion']) + '\n')
        result = {'protocolVersion':1, 'agentCapabilities':{}, 'authMethods':[], 'agentInfo':{'name':'fixture', 'version':'1'}}
    elif method == 'session/new': result = {'sessionId':'v1-session'}
    else: continue
    print(json.dumps({'jsonrpc':'2.0', 'id':ident, 'result':result}), flush=True)
"#).unwrap();
        let key = format!("v1-only-{}", uuid::Uuid::new_v4());
        let config = AcpStartConfig {
            agent_command: "/usr/bin/python3".into(),
            agent_name: "v1-only-fixture".into(),
            agent_args: vec![
                script.to_string_lossy().into_owned(),
                trace.to_string_lossy().into_owned(),
            ],
            working_dir: dir.path().into(),
            env_vars: HashMap::new(),
            project_key: key.clone(),
            task_id: "test".into(),
            chat_id: None,
            artifact_dir: Some(dir.path().join("artifacts")),
            additional_mcp_servers: Vec::new(),
            mcp_server_policy: super::super::McpServerPolicy::ExplicitOnly,
            agent_type: "local".into(),
            remote_url: None,
            remote_auth: None,
            suppress_initial_connecting: false,
            import_session: false,
            persona_injection: None,
        };
        for index in 0..2 {
            let (handle, mut events) =
                super::super::get_or_start_session(format!("{key}-{index}"), config.clone())
                    .await
                    .unwrap();
            tokio::time::timeout(std::time::Duration::from_secs(15), async {
                loop {
                    match events.recv().await.unwrap() {
                        super::super::AcpUpdate::SessionReady {
                            protocol_version, ..
                        } => {
                            assert_eq!(protocol_version, Some(1));
                            assert_eq!(
                                handle
                                    .protocol_version
                                    .load(std::sync::atomic::Ordering::Relaxed),
                                1
                            );
                            break;
                        }
                        super::super::AcpUpdate::Error { message } => panic!("v1 agent: {message}"),
                        _ => {}
                    }
                }
            })
            .await
            .unwrap();
            handle.request_shutdown();
        }
        assert_eq!(
            std::fs::read_to_string(trace)
                .unwrap()
                .lines()
                .collect::<Vec<_>>(),
            ["2", "1", "2", "1"]
        );
        assert_eq!(
            crate::storage::installed_agents::get_acp_protocol_version("v1-only-fixture").unwrap(),
            2
        );
    }
}

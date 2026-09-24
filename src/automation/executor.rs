//! Run a single Automation through its registered handler.
//!
//! `builtin.task_prompt` keeps the existing Task/Chat pipeline:
//! 1. Insert an `automation_runs` row in `queued` state (caught by the
//!    startup-sweep if Grove dies before completion).
//! 2. Resolve target Task (existing → check; new → spawn worktree + row).
//! 3. Resolve target ChatSession (existing → check; new → DB row).
//! 4. `agent_graph::tools::ensure_target_handle` spawns the ACP subprocess
//!    if it isn't already running.
//! 5. Subscribe to the handle's broadcast **before** `queue_message` to
//!    avoid a race where the agent picks up the prompt before we have a
//!    listener attached.
//! 6. Queue the prompt with `Some("automation:<run_id>")` as the sender so
//!    we can identify our turn in the broadcast stream.
//! 7. Stamp `queued_at` on the run row.
//! 8. Fire-and-forget background task: wait for the matching `UserMessage`
//!    (that's when the agent picked up our prompt), accumulate `MessageChunk`
//!    text, and close out only on `Complete`. Errors and disconnects stay in
//!    the Chat lifecycle so the user can continue the same Session.
//!
//! Registered project handlers use the same Automation-owned dedicated ACP
//! driver. Handlers contribute only concurrency, business pre/post actions and
//! runtime bindings.

use chrono::Utc;
use tokio::sync::broadcast::error::RecvError;

use crate::acp::{AcpStartConfig, AcpUpdate, QueuedMessage};
use crate::agent_graph::tools::ensure_target_handle;
use crate::storage::{
    automations::{self, Automation, AutomationRun, RunClaim, TargetMode},
    config, installed_agents, tasks, workspace,
};

use super::{awarn, consumer, cron_util};

pub struct RunOutcome {
    pub run_id: String,
    pub status: String, // persisted Runs remain active until completion or cancellation
    pub error: Option<String>,
    pub resolved_task_id: Option<String>,
    pub resolved_chat_id: Option<String>,
}

impl RunOutcome {
    pub fn failed(error: impl Into<String>) -> Self {
        Self::failed_run("", error, None, None)
    }

    pub fn failed_run(
        run_id: impl Into<String>,
        error: impl Into<String>,
        resolved_task_id: Option<String>,
        resolved_chat_id: Option<String>,
    ) -> Self {
        Self {
            run_id: run_id.into(),
            status: "failed".to_string(),
            error: Some(error.into()),
            resolved_task_id,
            resolved_chat_id,
        }
    }

    pub fn queued(
        run_id: impl Into<String>,
        resolved_task_id: Option<String>,
        resolved_chat_id: Option<String>,
    ) -> Self {
        Self {
            run_id: run_id.into(),
            status: "queued".to_string(),
            error: None,
            resolved_task_id,
            resolved_chat_id,
        }
    }

    pub fn skipped() -> Self {
        Self {
            run_id: String::new(),
            status: "skipped".to_string(),
            error: None,
            resolved_task_id: None,
            resolved_chat_id: None,
        }
    }
}

fn now() -> i64 {
    Utc::now().timestamp()
}

/// Run one automation. Inserts the run row, resolves task + chat, queues the
/// prompt, and spawns a background task that updates the row to its terminal
/// state once the agent reports completion or the user explicitly cancels.
///
/// Returns once the prompt is queued (or once a pre-queue failure happens).
/// The eventual completion lands in the `automation_runs` row asynchronously.
pub async fn run(automation: &Automation, trigger_kind: &str) -> RunOutcome {
    run_with_payload(automation, trigger_kind, None).await
}

pub async fn run_with_payload(
    automation: &Automation,
    trigger_kind: &str,
    trigger_payload: Option<serde_json::Value>,
) -> RunOutcome {
    if automation.handler_key != automations::TASK_PROMPT_HANDLER {
        let trigger = consumer::TriggerContext {
            kind: trigger_kind.to_string(),
            payload: trigger_payload,
        };
        return run_handler(automation, trigger).await;
    }

    let triggered_at = now();

    let run_id = match automations::insert_run(
        &automation.id,
        trigger_kind,
        trigger_payload.as_ref(),
        &automation.prompt,
        Some(agent_snapshot(automation))
            .filter(|s| !s.is_empty())
            .as_deref(),
        &automation.agent_config,
        &serde_json::json!({}),
        "task_chat",
        triggered_at,
    ) {
        Ok(id) => id,
        Err(e) => {
            // No row to write the error onto — surface to caller and bail.
            return RunOutcome {
                run_id: String::new(),
                status: "failed".to_string(),
                error: Some(format!("insert_run: {e}")),
                resolved_task_id: None,
                resolved_chat_id: None,
            };
        }
    };

    // 1. Resolve task ----------------------------------------------------
    let task_id = match resolve_task(automation) {
        Ok(id) => id,
        Err(e) => return fail(&run_id, "resolve_task", &e, None, None),
    };

    // 2. Resolve chat session -------------------------------------------
    let chat_id = match resolve_chat(automation, &task_id) {
        Ok(id) => id,
        Err(e) => return fail(&run_id, "resolve_session", &e, Some(&task_id), None),
    };

    // 2b. Stamp the resolved ids on the run row BEFORE any ACP work fires.
    //     The cancel handler reads `resolved_task_id` / `resolved_chat_id`
    //     to locate the ACP handle. If we deferred this until after
    //     send_prompt (as the original `mark_run_queued` did), a cancel
    //     fired in the meantime would mark the row `cancelled` but never
    //     dequeue / abort the ACP turn — the agent would keep running.
    //
    //     Treated as fatal: if this UPDATE fails (DB locked etc.) we abort
    //     before any ACP work, because *continuing* would put us back in
    //     the H2 bug class — DB row eventually cancelled while the agent
    //     happily processes the prompt because the cancel handler can't
    //     find the resolved ids.
    if let Err(e) = automations::mark_run_resolved(&run_id, &task_id, &chat_id) {
        return fail(
            &run_id,
            "stamp_resolved",
            &format!("mark_run_resolved: {e}"),
            Some(&task_id),
            Some(&chat_id),
        );
    }

    // 3. Ensure the ACP subprocess is up ---------------------------------
    let handle = match ensure_target_handle(&automation.project, &task_id, &chat_id).await {
        Ok(h) => h,
        Err(e) => {
            return fail(
                &run_id,
                "spawn_acp",
                &format!("ensure session: {e}"),
                Some(&task_id),
                Some(&chat_id),
            );
        }
    };

    // 4. Subscribe BEFORE handing the prompt to ACP. The agent could emit
    //    UserMessage + Complete within microseconds for a short prompt; if
    //    we subscribed after, those events go to no listener and the run
    //    remains invisible to the completion watcher.
    let rx = handle.subscribe();

    // 4b. Final pre-send cancel check. Narrows the post-`mark_run_resolved`
    //     window where a user-cancel could land *after* we stamped the
    //     ids but *before* we actually queued the prompt — without this,
    //     the row would be `cancelled` in the DB while the executor goes
    //     on to send_prompt and the agent runs. Still racy against a
    //     cancel that fires between this check and the send below, but
    //     that window is microseconds.
    if let Ok(Some(r)) = automations::get_run(&run_id) {
        if r.status != "queued" {
            return RunOutcome {
                run_id,
                status: r.status,
                error: None,
                resolved_task_id: Some(task_id),
                resolved_chat_id: Some(chat_id),
            };
        }
    }

    // 5. Idle vs busy — mirrors `agent_graph::tools::deliver_to_session`
    //    line 863-882: claim the busy slot with a CAS. If we win (session
    //    is idle), call send_prompt directly — the cmd_loop drains the
    //    pending queue only on `Complete`, so an idle session would hold
    //    a queued prompt forever (Bug 1). If we lose (something else is
    //    running), enqueue and let the end-of-turn drain pick it up.
    let snapshot = automation
        .agent_config
        .queued_config()
        .unwrap_or_else(|| handle.snapshot_config());
    let sender = format!("automation:{}", run_id);
    let claimed = handle
        .is_busy
        .compare_exchange(
            false,
            true,
            std::sync::atomic::Ordering::AcqRel,
            std::sync::atomic::Ordering::Acquire,
        )
        .is_ok();
    if claimed {
        match handle
            .send_prompt(
                automation.prompt.clone(),
                Vec::new(),
                Some(sender.clone()),
                false,
                Some(snapshot),
            )
            .await
        {
            Ok(()) => {}
            Err(error) => {
                handle.release_prompt_claim();
                let message = format!("send_prompt: {error}");
                if let Err(mark_error) = automations::mark_run_failed(&run_id, "queue", &message) {
                    awarn!("mark_run_failed for {run_id}: {mark_error}");
                }
                return RunOutcome {
                    run_id,
                    status: "failed".to_string(),
                    error: Some(message),
                    resolved_task_id: Some(task_id),
                    resolved_chat_id: Some(chat_id),
                };
            }
        }
    } else {
        let qmsg = QueuedMessage::new(
            automation.prompt.clone(),
            Vec::new(),
            Some(sender.clone()),
            false,
            Some(snapshot),
        );
        let updated = match handle.submit_queued_message(qmsg).await {
            Ok(updated) => updated,
            Err(error) => {
                let message = format!("queue_prompt: {error}");
                let _ = automations::mark_run_failed(&run_id, "queue", &message);
                return RunOutcome {
                    run_id,
                    status: "failed".to_string(),
                    error: Some(message),
                    resolved_task_id: Some(task_id),
                    resolved_chat_id: Some(chat_id),
                };
            }
        };
        handle.emit(AcpUpdate::QueueUpdate { messages: updated });
    }

    if let Err(e) = automations::mark_run_queued(&run_id, now()) {
        awarn!("mark_run_queued for {run_id}: {e}");
    }

    // 6. Fire-and-forget completion watcher.
    let run_id_for_task = run_id.clone();
    let sender_for_task = sender;
    tokio::spawn(async move {
        wait_for_completion(run_id_for_task, sender_for_task, rx).await;
    });

    RunOutcome {
        run_id,
        status: "queued".to_string(),
        error: None,
        resolved_task_id: Some(task_id),
        resolved_chat_id: Some(chat_id),
    }
}

async fn run_handler(automation: &Automation, trigger: consumer::TriggerContext) -> RunOutcome {
    let Some(handler) = consumer::get(&automation.handler_key) else {
        return RunOutcome::failed(format!(
            "unsupported Automation handler: {}",
            automation.handler_key
        ));
    };
    match handler.should_run(consumer::TriggerCheckContext {
        automation,
        trigger: &trigger,
    }) {
        Ok(true) => {}
        Ok(false) => return RunOutcome::skipped(),
        Err(error) => return RunOutcome::failed(format!("check Automation trigger: {error}")),
    }
    let single_flight =
        handler.concurrency_policy(automation) == consumer::ConcurrencyPolicy::SingleFlight;
    let agent_snapshot = automation
        .agent_config
        .agent_id()
        .map(installed_agents::canonicalize_agent_id);
    let run_id = match automations::claim_run(
        &automation.id,
        &trigger.kind,
        trigger.payload.as_ref(),
        &automation.prompt,
        agent_snapshot.as_deref(),
        &automation.agent_config,
        &serde_json::json!({}),
        "project_run",
        now(),
        single_flight,
    ) {
        Ok(RunClaim::Created(run_id)) => run_id,
        Ok(RunClaim::Existing(run)) => {
            return RunOutcome {
                run_id: run.id,
                status: run.status,
                error: None,
                resolved_task_id: run.resolved_task_id,
                resolved_chat_id: run.resolved_chat_id,
            }
        }
        Err(error) => return RunOutcome::failed(format!("claim Automation Run: {error}")),
    };
    let mut run = match automations::get_run(&run_id) {
        Ok(Some(run)) => run,
        Ok(None) => return RunOutcome::failed("claimed Automation Run disappeared"),
        Err(error) => {
            return fail_handler(
                automation,
                handler.as_ref(),
                &run_id,
                "prepare",
                &error.to_string(),
            )
        }
    };
    let input = match handler.pre_action(consumer::PreActionContext {
        automation,
        run: &run,
        trigger: &trigger,
    }) {
        Ok(input) => input,
        Err(error) => {
            return fail_handler(
                automation,
                handler.as_ref(),
                &run_id,
                "pre_action",
                &error.to_string(),
            )
        }
    };
    match automations::update_run_input(&run_id, &input) {
        Ok(true) => {}
        Ok(false) => {
            return fail_handler(
                automation,
                handler.as_ref(),
                &run_id,
                "pre_action",
                "Automation Run stopped before preparation completed",
            )
        }
        Err(error) => {
            return fail_handler(
                automation,
                handler.as_ref(),
                &run_id,
                "pre_action",
                &error.to_string(),
            )
        }
    }
    run = match automations::get_run(&run_id) {
        Ok(Some(run)) => run,
        Ok(None) => {
            return RunOutcome::failed_run(
                &run_id,
                "prepared Automation Run disappeared",
                None,
                None,
            )
        }
        Err(error) => {
            return fail_handler(
                automation,
                handler.as_ref(),
                &run_id,
                "pre_action",
                &error.to_string(),
            )
        }
    };
    let bindings = match handler.runtime_bindings(consumer::RuntimeContext {
        automation,
        run: &run,
    }) {
        Ok(bindings) => bindings,
        Err(error) => {
            return fail_handler(
                automation,
                handler.as_ref(),
                &run_id,
                "runtime_bindings",
                &error.to_string(),
            )
        }
    };
    let agent_id = match run.agent_config_snapshot.agent_id() {
        Some(agent_id) if !agent_id.trim().is_empty() => {
            installed_agents::canonicalize_agent_id(agent_id)
        }
        _ => {
            return fail_handler(
                automation,
                handler.as_ref(),
                &run_id,
                "resolve_agent",
                "Automation requires agent_config.agent_id",
            )
        }
    };
    let Some(resolved_agent) = crate::acp::resolve_agent(&agent_id) else {
        return fail_handler(
            automation,
            handler.as_ref(),
            &run_id,
            "resolve_agent",
            &format!("Agent is not available: {agent_id}"),
        );
    };
    // `_memory` is only an ordinary TaskChat storage namespace. It is not a
    // Task entity and has no row in the tasks table.
    let task_id = tasks::MEMORY_TASK_ID.to_string();
    let chat_id = tasks::generate_chat_id();
    let chat = tasks::ChatSession {
        id: chat_id.clone(),
        title: format!(
            "{} · {}",
            automation.name,
            Utc::now().format("%Y-%m-%d %H:%M")
        ),
        agent: agent_id.clone(),
        acp_session_id: None,
        created_at: Utc::now(),
        duty: None,
        launch_mode: "acp".to_string(),
    };
    if let Err(error) = tasks::add_chat_session(&automation.project, &task_id, chat) {
        return fail_handler(
            automation,
            handler.as_ref(),
            &run_id,
            "resolve_session",
            &format!("create Automation Run chat: {error}"),
        );
    }
    let session_key = format!("{}:{}:{}", automation.project, task_id, chat_id);
    let start_config = AcpStartConfig {
        agent_command: resolved_agent.command,
        agent_name: resolved_agent.agent_name,
        agent_args: resolved_agent.args,
        working_dir: bindings.working_dir,
        env_vars: bindings.env_vars,
        project_key: automation.project.clone(),
        task_id: task_id.clone(),
        chat_id: Some(chat_id.clone()),
        // Use the ordinary TaskChat history/session.jsonl location. Runtime
        // bindings still provide Memory MCP/env configuration, but no second
        // persistence path is introduced for the same conversation.
        artifact_dir: None,
        additional_mcp_servers: bindings.additional_mcp_servers,
        mcp_server_policy: bindings.mcp_server_policy,
        agent_type: resolved_agent.agent_type,
        remote_url: resolved_agent.url,
        remote_auth: resolved_agent.auth_header,
        suppress_initial_connecting: true,
        import_session: false,
        persona_injection: None,
    };
    let (handle, rx) =
        match crate::acp::get_or_start_session(session_key.clone(), start_config).await {
            Ok(value) => value,
            Err(error) => {
                let _ = tasks::delete_chat_session(&automation.project, &task_id, &chat_id);
                return fail_handler(
                    automation,
                    handler.as_ref(),
                    &run_id,
                    "spawn_acp",
                    &format!("start Automation Agent Session: {error}"),
                );
            }
        };
    if let Err(error) = automations::mark_run_resolved(&run_id, &task_id, &chat_id) {
        let _ = handle.kill().await;
        let _ = tasks::delete_chat_session(&automation.project, &task_id, &chat_id);
        return fail_handler(
            automation,
            handler.as_ref(),
            &run_id,
            "stamp_resolved",
            &format!("mark_run_resolved: {error}"),
        );
    }
    if let Err(error) = automations::mark_run_running(&run_id) {
        let _ = handle.kill().await;
        return fail_handler(
            automation,
            handler.as_ref(),
            &run_id,
            "start_run",
            &error.to_string(),
        );
    }
    if !matches!(automations::get_run(&run_id), Ok(Some(ref active)) if active.status == "running")
    {
        let _ = handle.kill().await;
        handler
            .abort(consumer::AbortContext {
                automation,
                run: &run,
                reason: "Run stopped before Agent start",
            })
            .ok();
        return RunOutcome::queued(run_id, None, None);
    }
    if let Err(error) = handle
        .send_prompt(
            run.prompt_snapshot.clone(),
            Vec::new(),
            Some(format!("automation:{run_id}")),
            false,
            run.agent_config_snapshot.queued_config(),
        )
        .await
    {
        let message = format!("send Automation prompt: {error}");
        if let Err(mark_error) = automations::mark_run_failed(&run_id, "queue", &message) {
            awarn!("mark_run_failed for {run_id}: {mark_error}");
        }
        return RunOutcome {
            run_id,
            status: "failed".to_string(),
            error: Some(message),
            resolved_task_id: run.resolved_task_id,
            resolved_chat_id: run.resolved_chat_id,
        };
    }
    if let Err(error) = automations::mark_run_queued(&run_id, now()) {
        awarn!("mark_run_queued for {run_id}: {error}");
    }
    let task_automation = automation.clone();
    let task_run = run;
    let task_handler = handler;
    tokio::spawn(async move {
        wait_for_handler_completion(task_handler, task_automation, task_run, rx).await;
    });
    RunOutcome::queued(run_id, None, None)
}

fn fail_handler(
    automation: &Automation,
    handler: &dyn consumer::AutomationHandler,
    run_id: &str,
    phase: &str,
    error: &str,
) -> RunOutcome {
    if let Ok(Some(run)) = automations::get_run(run_id) {
        if let Err(abort_error) = handler.abort(consumer::AbortContext {
            automation,
            run: &run,
            reason: error,
        }) {
            awarn!("abort handler for {run_id}: {abort_error}");
        }
    }
    if let Err(mark_error) = automations::mark_run_failed(run_id, phase, error) {
        awarn!("mark_run_failed for {run_id}: {mark_error}");
    }
    let status = automations::get_run(run_id)
        .ok()
        .flatten()
        .map(|run| run.status)
        .unwrap_or_else(|| "queued".to_string());
    RunOutcome {
        run_id: run_id.to_string(),
        status,
        error: Some(error.to_string()),
        resolved_task_id: None,
        resolved_chat_id: None,
    }
}

async fn wait_for_handler_completion(
    handler: std::sync::Arc<dyn consumer::AutomationHandler>,
    automation: Automation,
    initial_run: AutomationRun,
    mut rx: tokio::sync::broadcast::Receiver<AcpUpdate>,
) {
    let mut response = String::new();
    let mut turn_failed = false;
    loop {
        let update = match rx.recv().await {
            Ok(update) => update,
            Err(RecvError::Lagged(skipped)) => {
                awarn!(
                    "broadcast lagged for run {}: skipped {skipped} events",
                    initial_run.id
                );
                continue;
            }
            Err(RecvError::Closed) => {
                let _ = automations::mark_run_failed(
                    &initial_run.id,
                    "agent_run",
                    "Agent Session closed before the Run completed",
                );
                return;
            }
        };
        automations::publish_run_event(
            &automation.project,
            &automation.id,
            &initial_run.id,
            &update,
        );
        let Some(latest) = automations::get_run(&initial_run.id).ok().flatten() else {
            return;
        };
        if matches!(
            latest.status.as_str(),
            "success" | "cancelled" | "cancelling"
        ) {
            return;
        }
        match update {
            AcpUpdate::UserMessage { .. }
            | AcpUpdate::PermissionResponse { .. }
            | AcpUpdate::ElicitationResolved { .. }
            | AcpUpdate::AuthSucceeded => {
                turn_failed = false;
                response.clear();
                if let Err(error) = automations::mark_run_running(&latest.id) {
                    awarn!("mark_run_running for {}: {error}", latest.id);
                }
            }
            AcpUpdate::PermissionRequest { .. }
            | AcpUpdate::ElicitationRequest { .. }
            | AcpUpdate::AskForm { .. }
            | AcpUpdate::AuthRequired { .. }
            | AcpUpdate::AuthFailed { .. } => {
                if let Err(error) = automations::mark_run_waiting(&latest.id) {
                    awarn!("mark_run_waiting for {}: {error}", latest.id);
                }
            }
            AcpUpdate::MessageChunk { text } => response.push_str(&text),
            AcpUpdate::Complete { .. } => {
                match handler.completion_requested(consumer::RuntimeContext {
                    automation: &automation,
                    run: &latest,
                }) {
                    Ok(false) => {
                        if !turn_failed {
                            if let Err(error) = automations::mark_run_waiting(&latest.id) {
                                awarn!("mark_run_waiting for {}: {error}", latest.id);
                            }
                        }
                        continue;
                    }
                    Err(error) => {
                        automations::publish_run_event(
                            &automation.project,
                            &automation.id,
                            &latest.id,
                            &AcpUpdate::Error {
                                message: error.to_string(),
                            },
                        );
                        if let Err(mark_error) = automations::mark_run_failed(
                            &latest.id,
                            "completion_check",
                            &error.to_string(),
                        ) {
                            awarn!("mark_run_failed for {}: {mark_error}", latest.id);
                        }
                        turn_failed = true;
                        continue;
                    }
                    Ok(true) => {}
                }
                let truncated =
                    (!response.is_empty()).then(|| automations::truncate_agent_response(&response));
                match automations::complete_consumer_run(&latest.id, now(), |tx| {
                    let result = handler.post_action(
                        consumer::PostActionContext {
                            automation: &automation,
                            run: &latest,
                            agent_response: truncated.as_deref(),
                        },
                        tx,
                    )?;
                    tx.execute(
                        "UPDATE automation_runs SET agent_response = ?1 WHERE id = ?2",
                        rusqlite::params![truncated, latest.id],
                    )?;
                    Ok(((), result))
                }) {
                    Ok(Some(())) => {
                        if let Err(error) = handler.after_commit(consumer::AfterCommitContext {
                            automation: &automation,
                            run: &latest,
                        }) {
                            awarn!("after_commit for run {}: {error}", latest.id);
                        }
                        return;
                    }
                    Ok(None) => return,
                    Err(error) => {
                        automations::publish_run_event(
                            &automation.project,
                            &automation.id,
                            &latest.id,
                            &AcpUpdate::Error {
                                message: error.to_string(),
                            },
                        );
                        if let Err(mark_error) = automations::mark_run_failed(
                            &latest.id,
                            "complete_run",
                            &error.to_string(),
                        ) {
                            awarn!("mark_run_failed for {}: {mark_error}", latest.id);
                        }
                        turn_failed = true;
                    }
                }
            }
            AcpUpdate::Error { message } => {
                if let Err(error) = automations::mark_run_failed(&latest.id, "agent_run", &message)
                {
                    awarn!("mark_run_failed for {}: {error}", latest.id);
                }
                turn_failed = true;
            }
            AcpUpdate::SessionEnded => {
                let _ = automations::mark_run_failed(
                    &latest.id,
                    "agent_run",
                    "Agent Session ended before the Run completed",
                );
                return;
            }
            _ => {}
        }
    }
}

fn fail(
    run_id: &str,
    phase: &str,
    error: &str,
    task_id: Option<&str>,
    chat_id: Option<&str>,
) -> RunOutcome {
    if let Err(e) = automations::mark_run_failed(run_id, phase, error) {
        awarn!("mark_run_failed for {run_id}: {e}");
    }
    RunOutcome {
        run_id: run_id.to_string(),
        status: automations::get_run(run_id)
            .ok()
            .flatten()
            .map(|run| run.status)
            .unwrap_or_else(|| "queued".to_string()),
        error: Some(error.to_string()),
        resolved_task_id: task_id.map(String::from),
        resolved_chat_id: chat_id.map(String::from),
    }
}

fn agent_snapshot(a: &Automation) -> String {
    match &a.session_mode {
        TargetMode::New => a
            .session_template
            .as_ref()
            .map(|t| t.agent.clone())
            .unwrap_or_default(),
        TargetMode::Existing => match (&a.chat_id, &a.task_id) {
            // Look up the chat's actual agent so the run row's snapshot
            // reflects the persona the user will see when they open the
            // session. Falls back to an empty string when the lookup fails
            // (chat or task deleted) — the run row's `agent_snapshot` is
            // for display only, so a missing value is acceptable.
            (Some(cid), Some(tid)) => tasks::get_chat_session(&a.project, tid, cid)
                .ok()
                .flatten()
                .map(|c| c.agent)
                .unwrap_or_default(),
            _ => String::new(),
        },
    }
}

/// Background task: watch the ACP broadcast for events tagged with our
/// `automation:<run_id>` sender, accumulate the agent's response text, and
/// mark the Run completed only when ACP reports `Complete`.
///
/// State machine inside:
///   waiting_for_pickup → streaming → done
///
/// In `waiting_for_pickup` we discard everything except our matching
/// `UserMessage` — that's the signal the agent dequeued our prompt and
/// started this turn. From then on we accumulate `MessageChunk.text` and
/// wait for `Complete`. Errors remain part of the live conversation.
async fn wait_for_completion(
    run_id: String,
    sender: String,
    mut rx: tokio::sync::broadcast::Receiver<AcpUpdate>,
) {
    let mut started = false;
    let mut response = String::new();
    let mut turn_failed = false;
    loop {
        match rx.recv().await {
            Err(RecvError::Closed) => {
                let _ = automations::mark_run_failed(
                    &run_id,
                    "agent_run",
                    "Agent Session closed before the Run completed",
                );
                return;
            }
            Err(RecvError::Lagged(n)) => {
                awarn!("broadcast lagged for run {run_id}: skipped {n} events");
                continue;
            }
            Ok(update) => {
                if !matches!(
                    automations::get_run(&run_id),
                    Ok(Some(ref run)) if !matches!(run.status.as_str(), "success" | "cancelled" | "cancelling")
                ) {
                    return;
                }
                match update {
                    AcpUpdate::UserMessage {
                        sender: Some(s), ..
                    } if s == sender => {
                        started = true;
                        turn_failed = false;
                        response.clear();
                        // Promote queued → running so the UI shows "agent is
                        // actually working". Conditional UPDATE, so a cancel
                        // that beat us to the row stays cancelled.
                        if let Err(e) = automations::mark_run_running(&run_id) {
                            awarn!("mark_run_running for {run_id}: {e}");
                        }
                    }
                    AcpUpdate::UserMessage { .. } if started => {
                        turn_failed = false;
                        response.clear();
                        if let Err(e) = automations::mark_run_running(&run_id) {
                            awarn!("mark_run_running for {run_id}: {e}");
                        }
                    }
                    AcpUpdate::PermissionResponse { .. }
                    | AcpUpdate::ElicitationResolved { .. }
                    | AcpUpdate::AuthSucceeded
                        if started =>
                    {
                        if let Err(e) = automations::mark_run_running(&run_id) {
                            awarn!("mark_run_running for {run_id}: {e}");
                        }
                    }
                    AcpUpdate::PermissionRequest { .. }
                    | AcpUpdate::ElicitationRequest { .. }
                    | AcpUpdate::AskForm { .. }
                    | AcpUpdate::AuthRequired { .. }
                    | AcpUpdate::AuthFailed { .. }
                        if started =>
                    {
                        if let Err(e) = automations::mark_run_waiting(&run_id) {
                            awarn!("mark_run_waiting for {run_id}: {e}");
                        }
                    }
                    AcpUpdate::MessageChunk { text } if started => {
                        response.push_str(&text);
                    }
                    AcpUpdate::Complete { .. } if started && !turn_failed => {
                        let truncated = (!response.is_empty())
                            .then(|| automations::truncate_agent_response(&response));
                        if let Err(error) =
                            automations::mark_run_completed(&run_id, now(), truncated.as_deref())
                        {
                            awarn!("mark_run_completed for {run_id}: {error}");
                        }
                        return;
                    }
                    AcpUpdate::Complete { .. } if started => continue,
                    AcpUpdate::Error { message } if started => {
                        if let Err(e) = automations::mark_run_failed(&run_id, "agent_run", &message)
                        {
                            awarn!("mark_run_failed for {run_id}: {e}");
                        }
                        turn_failed = true;
                    }
                    AcpUpdate::SessionEnded => {
                        let _ = automations::mark_run_failed(
                            &run_id,
                            "agent_run",
                            "Agent Session ended before the Run completed",
                        );
                        return;
                    }
                    _ => continue,
                }
            }
        }
    }
}

// ── target resolution (unchanged) ───────────────────────────────────────

fn resolve_task(a: &Automation) -> Result<String, String> {
    match a.task_mode {
        TargetMode::Existing => {
            let task_id = a.task_id.clone().ok_or("existing mode requires task_id")?;
            tasks::get_task(&a.project, &task_id)
                .map_err(|e| e.to_string())?
                .ok_or("Task was deleted")?;
            Ok(task_id)
        }
        TargetMode::New => {
            let template = a
                .task_template
                .as_ref()
                .ok_or("new mode requires task_template")?;

            let project = workspace::load_project_by_hash(&a.project)
                .map_err(|e| e.to_string())?
                .ok_or("project not registered")?;

            let cfg = config::load_config();
            let session_type = cfg.default_session_type();
            let is_studio = project.project_type == workspace::ProjectType::Studio;

            let stamp = Utc::now().format("%Y%m%d-%H%M");
            let task_name = format!("{} ({})", template.name, stamp);

            let result = if is_studio {
                crate::operations::tasks::create_studio_task(
                    &project.path,
                    &a.project,
                    task_name,
                    &session_type,
                    "automation",
                )
            } else {
                let target = template
                    .target
                    .clone()
                    .or_else(|| crate::git::current_branch(&project.path).ok())
                    .unwrap_or_else(|| "main".to_string());
                let autolink = &cfg.auto_link.patterns;
                crate::operations::tasks::create_task(
                    &project.path,
                    &a.project,
                    task_name,
                    target,
                    &session_type,
                    autolink,
                    "automation",
                )
            }
            .map_err(|e| e.to_string())?;

            if let Some(notes) = template.notes.as_ref() {
                if !notes.is_empty() {
                    let _ = crate::storage::notes::save_notes(&a.project, &result.task.id, notes);
                }
            }

            Ok(result.task.id)
        }
    }
}

fn resolve_chat(a: &Automation, task_id: &str) -> Result<String, String> {
    match a.session_mode {
        TargetMode::Existing => {
            let chat_id = a.chat_id.clone().ok_or("existing mode requires chat_id")?;
            tasks::get_chat_session(&a.project, task_id, &chat_id)
                .map_err(|e| e.to_string())?
                .ok_or("Chat session was deleted")?;
            Ok(chat_id)
        }
        TargetMode::New => {
            let template = a
                .session_template
                .as_ref()
                .ok_or("new mode requires session_template")?;

            // Mirror the chat-create handler's title format
            // (`api/handlers/acp.rs::create_chat`, line ~1065): "{name}
            // 2026-05-25 14:30". No `Automation` prefix — the automation
            // chip on the card already conveys the source.
            let now = Utc::now();
            let stamp = now.format("%Y-%m-%d %H:%M");
            let title = template
                .title
                .clone()
                .unwrap_or_else(|| format!("{} {}", a.name, stamp));

            // Canonicalize the template agent id once. Legacy templates
            // (`claude`, `gh-copilot`, …) need to resolve to the post-v2.6
            // canonical row; we also persist the canonical id on the chat
            // so subsequent reads stay consistent.
            let canonical_agent = installed_agents::canonicalize_agent_id(&template.agent);

            // Derive launch_mode from selected channel + registry terminal_launch
            // (same rule as `acp::create_chat`). External + terminal_launch
            // present → "terminal"; everything else → "acp".
            let launch_mode = {
                let installed = installed_agents::get(&canonical_agent).ok().flatten();
                let is_terminal = installed
                    .as_ref()
                    .filter(|r| {
                        matches!(
                            r.selected_install_method,
                            installed_agents::InstallMethod::External
                        )
                    })
                    .and_then(|_| {
                        crate::storage::agent_registry::get()
                            .agents
                            .iter()
                            .find(|a| a.id == canonical_agent)
                            .and_then(|a| a.terminal_launch.clone())
                    })
                    .is_some();
                if is_terminal {
                    "terminal".to_string()
                } else {
                    "acp".to_string()
                }
            };

            let chat = tasks::ChatSession {
                id: tasks::generate_chat_id(),
                title,
                agent: canonical_agent,
                acp_session_id: None,
                created_at: now,
                duty: None,
                launch_mode,
            };
            tasks::add_chat_session(&a.project, task_id, chat.clone())
                .map_err(|e| e.to_string())?;
            Ok(chat.id)
        }
    }
}

/// Compute the next firing time for an automation. `None` when the cron
/// expression has no future occurrences (rare — usually a fixed past date).
/// Interpreted in the system local timezone — see `cron_util::next_unix`.
pub fn advance_next_run(a: &Automation) -> Option<i64> {
    cron_util::next_unix(&a.schedule_cron).ok().flatten()
}

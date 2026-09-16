use crate::radio::RadioEvent;
use crate::storage::connects::{self, Connect};

use super::adapter::{ActionResult, AdapterRef, InboundAction, InboundMessage, NoticeLevel};
use super::commands::{self, CardSpec, CommandOutcome, Parsed};

static STARTED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

fn ask_form_error_result(form_id: &str, error: String) -> ActionResult {
    match super::grove::pending_ask_form_card(form_id) {
        Some(card) => ActionResult::warning_card(error, card),
        None => ActionResult::notice(error, NoticeLevel::Error),
    }
}

pub fn start() {
    if STARTED.swap(true, std::sync::atomic::Ordering::AcqRel) {
        return;
    }
    tokio::spawn(async {
        let mut events = crate::radio::subscribe();
        while let Some(event) = events.recv().await {
            if let RadioEvent::Turn {
                project_id,
                task_id,
                chat_id,
                message_ids,
                event,
            } = event
            {
                // Grove Radio is an ordered stream. Process events in that
                // order; the Core has no private queue or per-turn watcher.
                super::grove::handle_turn_event(project_id, task_id, chat_id, message_ids, event)
                    .await;
            }
        }
    });
}
/// Drops transient core state for a deleted connection.
pub fn shutdown(id: &str) {
    super::grove::shutdown(id);
}

/// Handles a card interaction (agent picker, connection settings). The updated
/// card travels back inside the callback ACK, so the user sees the form turn
/// into a confirmation without an extra message — and a spent form can't be
/// submitted twice.
pub async fn handle_action(
    connection_id: &str,
    adapter: AdapterRef,
    action: InboundAction,
) -> Result<ActionResult, String> {
    // Reload the record: routing may have changed since this adapter started.
    let current = connects::get(connection_id)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "connection no longer exists".to_owned())?;
    // Only the bound chat's bound user may submit. Forwarded cards die here.
    let chat_matches = current.bound_chat_id.as_deref() == Some(&action.conversation_id);
    let user_matches = current.bound_user_id.as_deref() == Some(&action.sender_id);
    if !chat_matches || !user_matches {
        return Ok(ActionResult::ignored());
    }
    let field = |key: &str| {
        action
            .fields
            .get(key)
            .map(String::as_str)
            .unwrap_or_default()
            .trim()
            .to_owned()
    };
    match action.name.as_deref() {
        Some("permission") => {
            let request_id = field("request_id");
            let option_id = field("option_id");
            if request_id.is_empty() || option_id.is_empty() {
                return Err("Invalid permission response.".into());
            }
            super::grove::respond_permission(&current, &request_id, &option_id)?;
            Ok(ActionResult::notice(
                "Permission response sent. The agent is continuing.",
                NoticeLevel::Success,
            ))
        }
        Some(name) if name.starts_with("elicitation_submit:") => {
            let request_id = name.trim_start_matches("elicitation_submit:");
            match super::grove::respond_elicitation(&current, request_id, true, &action.fields) {
                Ok(()) => Ok(ActionResult::notice(
                    "Response sent. The agent is continuing.",
                    NoticeLevel::Success,
                )),
                Err(error) => match super::grove::pending_elicitation_card(&current, request_id) {
                    Some(card) => Ok(ActionResult::warning_card(error, card)),
                    None => Err(error),
                },
            }
        }
        Some(name) if name.starts_with("elicitation_decline:") => {
            let request_id = name.trim_start_matches("elicitation_decline:");
            super::grove::respond_elicitation(&current, request_id, false, &action.fields)?;
            Ok(ActionResult::notice(
                "Request declined. The agent is continuing.",
                NoticeLevel::Info,
            ))
        }
        Some(name) if name.starts_with("ask_form_submit:") => {
            let form_id = name.trim_start_matches("ask_form_submit:");
            let Some(source_message_id) = action.source_message_id.as_deref() else {
                return Ok(ask_form_error_result(
                    form_id,
                    "This form response has no reply target.".into(),
                ));
            };
            // Validation failures (e.g. a non-numeric Number answer) bounce
            // back to the user as a card error — the form stays fillable.
            let text = match super::grove::ask_form_response_text(form_id, &action.fields) {
                Ok(text) => text,
                Err(error) => return Ok(ask_form_error_result(form_id, error)),
            };
            let inbound = InboundMessage {
                external_message_id: source_message_id.to_owned(),
                conversation_id: action.conversation_id.clone(),
                sender_id: action.sender_id.clone(),
                text: text.clone(),
                attachments: Vec::new(),
            };
            match super::grove::deliver_prompt(current, adapter.clone(), inbound, text).await {
                Ok(()) => {
                    super::grove::complete_ask_form(form_id);
                    Ok(ActionResult::notice(
                        "Response sent. The agent is continuing.",
                        NoticeLevel::Success,
                    ))
                }
                Err(error) => {
                    super::grove::reopen_ask_form(form_id);
                    Ok(ask_form_error_result(form_id, error))
                }
            }
        }
        Some(name) if name.starts_with("ask_form_decline:") => {
            let form_id = name.trim_start_matches("ask_form_decline:");
            super::grove::dismiss_ask_form(form_id);
            Ok(ActionResult::notice("Form dismissed.", NoticeLevel::Info))
        }
        Some("new_session_btn") => {
            let agent = field("agent");
            if agent.is_empty() {
                return Err("Pick an agent before submitting.".into());
            }
            if current.project_id.is_empty() || current.task_id.is_empty() {
                return Err(
                    "This connection has no Grove target yet. Send /target to set it up.".into(),
                );
            }
            super::grove::create_session(&current, Some(&agent))?;
            Ok(ActionResult::notice(
                format!("New session started with {agent}."),
                NoticeLevel::Success,
            ))
        }
        Some("update_options_btn") => {
            // Refresh the child option lists for the parent values currently
            // picked in the form. Soft validation: unknown/下线 values just
            // clear — never an error, never persisted.
            let mut project = field("project");
            let mut task = field("task");
            let mut session = field("session");
            if !project.is_empty()
                && crate::storage::workspace::load_project_by_hash(&project)
                    .map_err(|error| error.to_string())?
                    .is_none()
            {
                project.clear();
            }
            if !task.is_empty()
                && (project.is_empty()
                    || crate::storage::tasks::get_task(&project, &task)
                        .map_err(|error| error.to_string())?
                        .is_none())
            {
                task.clear();
            }
            if !session.is_empty()
                && (task.is_empty()
                    || crate::storage::tasks::get_chat_session(&project, &task, &session)
                        .map_err(|error| error.to_string())?
                        .is_none())
            {
                session.clear();
            }
            let mut next = current.clone();
            next.project_id = project;
            next.task_id = task;
            next.session_id = session;
            Ok(ActionResult::card(commands::target_card(&next)))
        }
        Some("save_target_btn") => {
            let project = field("project");
            let task = field("task");
            let session = field("session");
            if !task.is_empty() && project.is_empty() {
                return Err("Select a project before selecting a task.".into());
            }
            if !session.is_empty() && task.is_empty() {
                return Err("Select a task before selecting a session.".into());
            }
            if !project.is_empty() && task.is_empty() {
                return Err("Select a task for the project, then save.".into());
            }
            if !project.is_empty()
                && crate::storage::workspace::load_project_by_hash(&project)
                    .map_err(|error| error.to_string())?
                    .is_none()
            {
                return Err(
                    "The selected project no longer exists in Grove. Pick another project (or Not routed), then save."
                        .into(),
                );
            }
            // Stale child value: the picked task belongs to a different (or
            // deleted) project — typically the project was switched without
            // pressing Update options. Refresh the card instead of dead-ending.
            if !task.is_empty()
                && crate::storage::tasks::get_task(&project, &task)
                    .map_err(|error| error.to_string())?
                    .is_none()
            {
                let message = match task_home_project(&task) {
                    Some(home) if home != project => {
                        let home_name = crate::storage::workspace::load_project_by_hash(&home)
                            .ok()
                            .flatten()
                            .map(|project| project.name)
                            .unwrap_or_else(|| home.clone());
                        format!(
                            "Task \"{task}\" belongs to project \"{home_name}\". Task list refreshed for the selected project — pick a task, then save."
                        )
                    }
                    _ => "The selected task no longer exists. Task list refreshed — pick a task, then save.".into(),
                };
                let mut next = current.clone();
                next.project_id = project;
                next.task_id.clear();
                next.session_id.clear();
                return Ok(ActionResult::warning_card(
                    message,
                    commands::target_card(&next),
                ));
            }
            if !session.is_empty()
                && crate::storage::tasks::get_chat_session(&project, &task, &session)
                    .map_err(|error| error.to_string())?
                    .is_none()
            {
                let message = match crate::storage::tasks::find_chat_session(&session)
                    .ok()
                    .flatten()
                {
                    Some((home_project, home_task, chat)) if home_project != project || home_task != task => {
                        let task_name = crate::storage::tasks::get_task(&home_project, &home_task)
                            .ok()
                            .flatten()
                            .map(|task| task.name)
                            .unwrap_or_else(|| home_task.clone());
                        format!(
                            "Session \"{title}\" belongs to task \"{task_name}\". Session list refreshed — pick a session, then save.",
                            title = chat.title
                        )
                    }
                    _ => "The selected session no longer exists. Session list refreshed — pick a session, then save.".into(),
                };
                let mut next = current.clone();
                next.project_id = project;
                next.task_id = task;
                next.session_id.clear();
                return Ok(ActionResult::warning_card(
                    message,
                    commands::target_card(&next),
                ));
            }

            // Every level validated — apply atomically.
            connects::set_routing(&current.id, &project, &task, &session)
                .map_err(|error| error.to_string())?;
            let mut next = current.clone();
            next.project_id = project.clone();
            next.task_id = task.clone();
            next.session_id = session.clone();
            let note = if session.is_empty() {
                "Session: Auto New — created on the first message.".to_owned()
            } else {
                "Session: routed to the existing session.".to_owned()
            };
            let target = describe_target(&next);
            Ok(ActionResult::notice(
                format!("Target saved — routing to {target}.\n{note}"),
                NoticeLevel::Success,
            ))
        }
        Some("save_config_btn") => {
            if current.session_id.is_empty() {
                return Err("No session is running yet — send a message first.".into());
            }
            let Some(session) =
                crate::grove::session(&current.project_id, &current.task_id, &current.session_id)
            else {
                return Err(
                    "The session is not running right now — send a message first, then retry."
                        .into(),
                );
            };
            // The selectors are read fresh from the handle; "opt_<index>"
            // field names map positionally onto this list. Only options whose
            // submitted value differs from the session's current value get an
            // ACP `set_config_option` RPC.
            let selectors = session.config_selectors();
            let mut applied: Vec<String> = Vec::new();
            for (index, selector) in selectors.iter().enumerate() {
                let value = field(&format!("opt_{index}"));
                if value.is_empty() || Some(&value) == selector.current.as_ref() {
                    continue;
                }
                if !selector.options.iter().any(|(option, _)| option == &value) {
                    return Err(format!(
                        "\"{value}\" is not a valid option for {} — the session's options may have changed. Reopen /config and try again.",
                        selector.label
                    ));
                }
                session
                    .set_config_option(selector.config_id.clone(), value.clone())
                    .await?;
                applied.push(format!("{} → {value}", selector.label));
            }
            if applied.is_empty() {
                return Ok(ActionResult::notice(
                    "No changes to apply.",
                    NoticeLevel::Info,
                ));
            }
            Ok(ActionResult::notice(
                format!("Updated:\n{}", applied.join("\n")),
                NoticeLevel::Success,
            ))
        }
        _ => Ok(ActionResult::ignored()),
    }
}

fn describe_target(connect: &Connect) -> String {
    let project = crate::storage::workspace::load_project_by_hash(&connect.project_id)
        .ok()
        .flatten()
        .map(|project| project.name)
        .unwrap_or_else(|| connect.project_id.clone());
    let task = crate::storage::tasks::get_task(&connect.project_id, &connect.task_id)
        .ok()
        .flatten()
        .map(|task| task.name)
        .unwrap_or_else(|| connect.task_id.clone());
    format!("{project} / {task}")
}

/// Finds the project hash a task id belongs to. Task ids are only unique per
/// project (`_local` exists in every project), so this is a best-effort
/// lookup used to explain stale selections in error messages.
fn task_home_project(task_id: &str) -> Option<String> {
    for project in crate::storage::workspace::load_active_projects().ok()? {
        let hash = crate::storage::workspace::project_hash(&project.path);
        if crate::storage::tasks::get_task(&hash, task_id)
            .ok()
            .flatten()
            .is_some()
        {
            return Some(hash);
        }
    }
    None
}

async fn handle_parsed_message(
    connect: Connect,
    adapter: AdapterRef,
    inbound: InboundMessage,
) -> Result<(), String> {
    match commands::parse(&inbound.text) {
        Parsed::Command(def, args) => {
            run_command(
                &connect,
                &adapter,
                &inbound.external_message_id,
                def.name,
                &args,
            )
            .await
        }
        Parsed::Prompt => {
            let text = inbound.text.clone();
            super::grove::deliver_prompt(connect, adapter, inbound, text).await
        }
    }
}

/// Accepts one platform-neutral message after the adapter has validated and
/// acknowledged its native event. Connection lookup, binding, commands,
/// mapping and Grove delivery are all Core responsibilities.
pub async fn handle_message(connection_id: &str, adapter: AdapterRef, inbound: InboundMessage) {
    let bound =
        connects::bind_private_chat(connection_id, &inbound.conversation_id, &inbound.sender_id)
            .unwrap_or(false);
    if !bound {
        return;
    }
    let current = match connects::get(connection_id) {
        Ok(Some(current)) if current.enabled => current,
        Ok(_) => return,
        Err(error) => {
            eprintln!("[connect] load current routing failed: {error}");
            return;
        }
    };
    let external_message_id = inbound.external_message_id.clone();
    if let Err(error) = handle_parsed_message(current, adapter.clone(), inbound).await {
        let _ = adapter
            .reply_text(
                &external_message_id,
                &format!("Grove Connect error: {error}"),
            )
            .await;
    }
}

async fn run_command(
    connect: &Connect,
    adapter: &AdapterRef,
    message_id: &str,
    name: &str,
    args: &str,
) -> Result<(), String> {
    let outcome = match name {
        "help" => CommandOutcome::Reply(commands::help()),
        "status" => CommandOutcome::Reply(status_command(connect).await?),
        "cancel" => CommandOutcome::Reply(cancel_command(connect).await?),
        // /clear is an alias of /new: both start a fresh session.
        "new" | "clear" => {
            if connect.project_id.is_empty() || connect.task_id.is_empty() {
                CommandOutcome::Reply(
                    "This connection has no Grove target yet. Send /target to set it up.".into(),
                )
            } else {
                let current_agent = if connect.session_id.is_empty() {
                    None
                } else {
                    crate::storage::tasks::get_chat_session(
                        &connect.project_id,
                        &connect.task_id,
                        &connect.session_id,
                    )
                    .ok()
                    .flatten()
                    .map(|chat| chat.agent)
                };
                CommandOutcome::Card(CardSpec::NewSession {
                    agents: commands::agent_options(),
                    current: current_agent,
                })
            }
        }
        "config" => {
            let reason = config_card_reason(connect);
            match reason {
                Some(reason) => CommandOutcome::Reply(reason),
                None => {
                    let spec = live_config_card(connect);
                    match &spec {
                        CardSpec::Config(config) if config.selectors.is_empty() => {
                            CommandOutcome::Reply(
                                "The running session exposes no configurable options.".into(),
                            )
                        }
                        _ => CommandOutcome::Card(spec),
                    }
                }
            }
        }
        "target" => {
            if commands::project_options().is_empty() {
                CommandOutcome::Reply(
                    "No projects are registered in Grove yet. Add one first, then retry /target."
                        .into(),
                )
            } else {
                CommandOutcome::Card(commands::target_card(connect))
            }
        }
        "skill" => {
            if args.trim().is_empty() {
                CommandOutcome::Reply(
                    "Usage: /skill <name> [prompt] — e.g. /skill review this PR".into(),
                )
            } else {
                CommandOutcome::ForwardToAgent(format!("/{args}"))
            }
        }
        other => CommandOutcome::Reply(format!("Unknown command /{other}.")),
    };
    match outcome {
        CommandOutcome::Reply(text) => {
            adapter.reply_text(message_id, &text).await?;
            Ok(())
        }
        CommandOutcome::Card(spec) => {
            adapter.reply_card(message_id, &spec).await?;
            Ok(())
        }
        CommandOutcome::ForwardToAgent(text) => {
            let inbound = InboundMessage {
                external_message_id: message_id.to_owned(),
                conversation_id: String::new(),
                sender_id: String::new(),
                text: text.clone(),
                attachments: Vec::new(),
            };
            super::grove::deliver_prompt(connect.clone(), adapter.clone(), inbound, text).await
        }
    }
}

/// Why /config can't render right now — the card is built purely from a live
/// session's advertised config options, so spawning an agent process just to
/// show it is never worth it.
fn config_card_reason(connect: &Connect) -> Option<String> {
    if connect.project_id.is_empty() || connect.task_id.is_empty() {
        return Some("This connection has no Grove target yet. Send /target to set it up.".into());
    }
    if connect.session_id.is_empty() {
        return Some(
            "No session yet — one is created on the first message. Send /new to start one now."
                .into(),
        );
    }
    if crate::grove::session(&connect.project_id, &connect.task_id, &connect.session_id).is_none() {
        return Some(
            "The session is not running right now — send a message to wake it, then retry /config."
                .into(),
        );
    }
    None
}

/// Assembles the /config card from the live handle's config options snapshot:
/// one dropdown per select-style option (mode / model / effort / …), each
/// preselected with its current value. Field names are positional so the
/// callback maps submissions back onto the handle's list.
fn live_config_card(connect: &Connect) -> CardSpec {
    let selectors =
        crate::grove::session(&connect.project_id, &connect.task_id, &connect.session_id)
            .map(|session| session.config_selectors())
            .unwrap_or_default();
    CardSpec::Config(Box::new(commands::ConfigCard {
        selectors: selectors
            .into_iter()
            .enumerate()
            .map(|(index, selector)| commands::ConfigSelectorOption {
                name: format!("opt_{index}"),
                label: selector.label,
                current: selector.current,
                options: selector.options,
            })
            .collect(),
    }))
}

async fn status_command(connect: &Connect) -> Result<String, String> {
    if connect.project_id.is_empty() || connect.task_id.is_empty() {
        return Ok("This connection has no Grove target yet. Send /target to set it up.".into());
    }
    let project = crate::storage::workspace::load_project_by_hash(&connect.project_id)
        .ok()
        .flatten()
        .map(|project| project.name)
        .unwrap_or_else(|| connect.project_id.clone());
    let task = crate::storage::tasks::get_task(&connect.project_id, &connect.task_id)
        .ok()
        .flatten()
        .map(|task| task.name)
        .unwrap_or_else(|| connect.task_id.clone());
    if connect.session_id.is_empty() {
        return Ok(format!(
            "Project: {project}\nTask: {task}\nState: no session yet — one will be created on the first message."
        ));
    }
    let (title, agent) = crate::storage::tasks::get_chat_session(
        &connect.project_id,
        &connect.task_id,
        &connect.session_id,
    )
    .map_err(|error| error.to_string())?
    .map(|chat| (chat.title, chat.agent))
    .unwrap_or_else(|| (connect.session_id.clone(), "unknown".into()));
    // Status never spawns the agent: without a live handle we report what
    // storage knows and stop there.
    let Some(_session) =
        crate::grove::session(&connect.project_id, &connect.task_id, &connect.session_id)
    else {
        return Ok(format!(
            "Session: {title} ({agent})\nProject: {project}\nTask: {task}\nState: not running — send a message to start it."
        ));
    };
    let snapshot =
        crate::grove::snapshot(&connect.project_id, &connect.task_id, &connect.session_id)
            .ok_or_else(|| "The agent session is no longer running.".to_owned())?;
    let queued = snapshot.queued;
    let busy = snapshot.busy;
    let state = if busy {
        if queued > 0 {
            format!("working — {queued} queued")
        } else {
            "working".to_owned()
        }
    } else {
        "idle".to_owned()
    };
    let mut lines = vec![
        format!("Session: {title} ({agent})"),
        format!("Project: {project}"),
        format!("Task: {task}"),
        format!("State: {state}"),
    ];
    if let Some(model) = snapshot.config.model {
        lines.push(format!("Model: {model}"));
    }
    if let Some(mode) = snapshot.config.mode {
        lines.push(format!("Mode: {mode}"));
    }
    if let Some(effort) = snapshot.config.thought_level {
        lines.push(format!("Effort: {effort}"));
    }
    if let Some(usage) = &snapshot.usage {
        if usage.size > 0 {
            let percent = (usage.used as f64 / usage.size as f64 * 100.0).round() as u64;
            lines.push(format!(
                "Context: {} / {} ({percent}%)",
                format_tokens(usage.used),
                format_tokens(usage.size)
            ));
        }
    }
    if let Some(cost) = snapshot.usage.and_then(|usage| usage.cost) {
        lines.push(format!("Cost: {:.2} {}", cost.amount, cost.currency));
    }
    Ok(lines.join("\n"))
}

fn format_tokens(tokens: u64) -> String {
    if tokens >= 1_000_000 {
        format!("{:.1}M", tokens as f64 / 1_000_000.0)
    } else if tokens >= 1_000 {
        format!("{:.1}k", tokens as f64 / 1_000.0)
    } else {
        tokens.to_string()
    }
}

async fn cancel_command(connect: &Connect) -> Result<String, String> {
    if connect.project_id.is_empty() || connect.task_id.is_empty() || connect.session_id.is_empty()
    {
        return Ok("No active session — nothing to cancel.".into());
    }
    // Cancelling never spawns the agent: if the session isn't running there
    // is nothing to cancel.
    let Some(session) =
        crate::grove::session(&connect.project_id, &connect.task_id, &connect.session_id)
    else {
        return Ok("The agent is not running — nothing to cancel.".into());
    };
    let Some(snapshot) =
        crate::grove::snapshot(&connect.project_id, &connect.task_id, &connect.session_id)
    else {
        return Ok("The agent is not running — nothing to cancel.".into());
    };
    if !snapshot.busy {
        return Ok("Agent is idle — nothing to cancel.".into());
    }
    session.cancel().await?;
    Ok("Cancellation requested.".into())
}

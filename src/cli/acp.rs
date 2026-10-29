//! `grove acp <agent>` — 交互式 ACP 聊天测试工具

use std::collections::HashMap;
use std::io::{self, BufRead, Write};
use std::path::PathBuf;

use crate::acp::{self, AcpStartConfig, AcpUpdate, ContentBlockData};

fn v2_message_delta(
    messages: &mut acp::v2_messages::Messages,
    update: &agent_client_protocol::schema::v2::SessionUpdate,
) -> Option<(bool, String)> {
    use acp::v2_messages::MessageKind;
    use agent_client_protocol::schema::v2::{ContentBlock, SessionUpdate};
    let (kind, id) = match update {
        SessionUpdate::AgentMessage(message) => {
            (MessageKind::Agent, message.message_id.to_string())
        }
        SessionUpdate::AgentMessageChunk(message) => {
            (MessageKind::Agent, message.message_id.to_string())
        }
        SessionUpdate::AgentThought(message) => {
            (MessageKind::Thought, message.message_id.to_string())
        }
        SessionUpdate::AgentThoughtChunk(message) => {
            (MessageKind::Thought, message.message_id.to_string())
        }
        _ => return None,
    };
    let text = |messages: &acp::v2_messages::Messages| {
        messages
            .entries()
            .iter()
            .find(|message| message.kind == kind && message.id == id)
            .map(|message| {
                message
                    .content
                    .iter()
                    .filter_map(|block| match block {
                        ContentBlock::Text(text) => Some(text.text.clone()),
                        ContentBlock::Image(image) => Some(format!(
                            "\n[Image: {}]\n",
                            image.uri.as_deref().unwrap_or("image")
                        )),
                        ContentBlock::Audio(_) => Some("\n[Audio]\n".to_owned()),
                        ContentBlock::ResourceLink(resource) => {
                            Some(format!("\n[Resource: {}]\n", resource.uri))
                        }
                        ContentBlock::Resource(_) => Some("\n[Embedded resource]\n".to_owned()),
                        _ => None,
                    })
                    .collect::<String>()
            })
            .unwrap_or_default()
    };
    let before = text(messages);
    messages.apply(update);
    let after = text(messages);
    let delta = after
        .strip_prefix(&before)
        .map(str::to_owned)
        .unwrap_or_else(|| format!("\n{after}"));
    Some((kind == MessageKind::Thought, delta))
}

fn display_v2_tool_content(content: &agent_client_protocol::schema::v2::ToolCallContent) {
    if let Ok(value) = serde_json::to_value(content) {
        if let Some(text) = value
            .pointer("/content/text")
            .or_else(|| value.pointer("/patch/text"))
            .and_then(|value| value.as_str())
        {
            eprintln!("{text}");
        }
    }
}

/// 执行 ACP 交互式聊天
pub async fn execute(agent: String, cwd: String) {
    let working_dir = PathBuf::from(&cwd)
        .canonicalize()
        .unwrap_or_else(|_| PathBuf::from(&cwd));

    // 解析 agent 名称
    let resolved = match acp::resolve_agent(&agent) {
        Some(r) => r,
        None => {
            eprintln!("Unknown agent: '{}'. Supported agents: claude", agent);
            std::process::exit(1);
        }
    };

    eprintln!("Starting ACP session with '{}'...", agent);
    eprintln!("Working directory: {}", working_dir.display());

    let config = AcpStartConfig {
        agent_command: resolved.command,
        agent_name: resolved.agent_name,
        agent_args: resolved.args,
        working_dir,
        env_vars: HashMap::new(),
        project_key: String::new(),
        task_id: String::new(),
        chat_id: None,
        artifact_dir: None,
        additional_mcp_servers: Vec::new(),
        mcp_server_policy: crate::acp::McpServerPolicy::WorkingSession,
        agent_type: resolved.agent_type,
        remote_url: resolved.url,
        remote_auth: resolved.auth_header,
        suppress_initial_connecting: false,
        import_session: false,
        persona_injection: None,
    };

    let (handle, mut update_rx) = match acp::get_or_start_session("cli".to_string(), config).await {
        Ok(result) => result,
        Err(e) => {
            eprintln!("Failed to start ACP session: {}", e);
            std::process::exit(1);
        }
    };

    // 等待 SessionReady
    loop {
        match update_rx.recv().await {
            Ok(AcpUpdate::SessionReady {
                session_id,
                agent_name,
                agent_version,
                ..
            }) => {
                eprintln!(
                    "Connected to {} (v{})\nSession: {}\n",
                    agent_name, agent_version, session_id
                );
                break;
            }
            Ok(AcpUpdate::SessionNotice {
                severity,
                title,
                description,
            }) => {
                eprintln!(
                    "[{}] {}{}",
                    severity,
                    title,
                    description
                        .map(|value| format!("\n{}", value))
                        .unwrap_or_default()
                );
            }
            Ok(AcpUpdate::Error { message }) => {
                eprintln!("Error: {}", message);
                std::process::exit(1);
            }
            Ok(AcpUpdate::SessionEnded) => {
                eprintln!("Session ended unexpectedly.");
                std::process::exit(1);
            }
            Err(e) => {
                eprintln!("Channel error: {}", e);
                std::process::exit(1);
            }
            _ => continue,
        }
    }

    // 交互式 prompt 循环
    let stdin = io::stdin();
    let mut reader = stdin.lock();
    let handle_for_input = handle.clone();
    let mut v2_messages = acp::v2_messages::Messages::default();
    let mut v2_terminals: HashMap<String, String> = HashMap::new();

    loop {
        // 显示提示符
        eprint!("> ");
        io::stderr().flush().ok();

        // 读取一行用户输入
        let mut line = String::new();
        match reader.read_line(&mut line) {
            Ok(0) => break, // EOF
            Err(e) => {
                eprintln!("Read error: {}", e);
                break;
            }
            _ => {}
        }

        let text = line.trim().to_string();
        if text.is_empty() {
            continue;
        }
        if text == "exit" || text == "quit" {
            break;
        }

        // 发送 prompt
        if let Err(e) = handle_for_input
            .send_prompt(text, vec![], None, false, None)
            .await
        {
            eprintln!("Failed to send prompt: {}", e);
            break;
        }

        // 读取流式响应直到 Complete 或 Error
        loop {
            let update = match update_rx.recv().await {
                Ok(AcpUpdate::SubagentEvent { session_id, event }) => {
                    eprintln!("[Subagent {session_id}]");
                    Ok(*event)
                }
                other => other,
            };
            match update {
                Ok(AcpUpdate::V2MessageUpdate { update }) => {
                    if let Some((thought, delta)) = v2_message_delta(&mut v2_messages, &update) {
                        if thought {
                            eprint!("\x1b[90m{}\x1b[0m", delta);
                            io::stderr().flush().ok();
                        } else {
                            print!("{}", delta);
                            io::stdout().flush().ok();
                        }
                    }
                }
                Ok(AcpUpdate::V2ToolUpdate { update }) => {
                    use agent_client_protocol::schema::{v2::SessionUpdate, MaybeUndefined};
                    match update {
                        SessionUpdate::ToolCallUpdate(tool) => {
                            let title = match tool.title {
                                MaybeUndefined::Value(value) => value,
                                _ => tool.tool_call_id.to_string(),
                            };
                            let status = match tool.status {
                                MaybeUndefined::Value(value) => serde_json::to_value(value)
                                    .ok()
                                    .and_then(|v| v.as_str().map(str::to_owned))
                                    .unwrap_or_default(),
                                _ => String::new(),
                            };
                            eprintln!("\x1b[36m[Tool: {title} {status}]\x1b[0m");
                            if let MaybeUndefined::Value(content) = tool.content {
                                for item in &content {
                                    display_v2_tool_content(item);
                                }
                            }
                        }
                        SessionUpdate::ToolCallContentChunk(chunk) => {
                            display_v2_tool_content(&chunk.content)
                        }
                        _ => {}
                    }
                }
                Ok(AcpUpdate::V2TerminalOutputUpdate {
                    terminal_id,
                    output,
                    ..
                }) => {
                    let previous = v2_terminals.entry(terminal_id).or_default();
                    let delta = output
                        .strip_prefix(previous.as_str())
                        .map(str::to_owned)
                        .unwrap_or_else(|| format!("\n{output}"));
                    if !delta.is_empty() {
                        eprint!("{delta}");
                        io::stderr().flush().ok();
                    }
                    *previous = output;
                }
                Ok(AcpUpdate::MessageChunk {
                    message_id: _,
                    text,
                }) => {
                    print!("{}", text);
                    io::stdout().flush().ok();
                }
                Ok(AcpUpdate::MessageContentChunk {
                    message_id: _,
                    content,
                }) => {
                    match content {
                        ContentBlockData::Image { mime_type, uri, .. } => {
                            println!("\n[Image: {}]", uri.as_deref().unwrap_or(&mime_type))
                        }
                        ContentBlockData::Audio { mime_type, .. } => {
                            println!("\n[Audio: {}]", mime_type)
                        }
                        ContentBlockData::ResourceLink {
                            uri, name, title, ..
                        } => println!("\n[Resource: {} — {}]", title.unwrap_or(name), uri),
                        ContentBlockData::Resource {
                            uri,
                            mime_type,
                            text,
                            ..
                        } => {
                            if let Some(text) = text {
                                println!("\n{}", text);
                            } else {
                                println!(
                                    "\n[Embedded resource: {} — {}]",
                                    mime_type.as_deref().unwrap_or("binary"),
                                    uri
                                );
                            }
                        }
                        ContentBlockData::Text { text } => print!("{}", text),
                    }
                    io::stdout().flush().ok();
                }
                Ok(AcpUpdate::ThoughtChunk {
                    message_id: _,
                    text,
                }) => {
                    // 灰色打印思考过程
                    eprint!("\x1b[90m{}\x1b[0m", text);
                    io::stderr().flush().ok();
                }
                Ok(AcpUpdate::ToolCall { id: _, title, .. }) => {
                    eprintln!("\x1b[36m[Tool: {}]\x1b[0m", title);
                }
                Ok(AcpUpdate::ToolCallV1 {
                    title,
                    name,
                    status,
                    ..
                }) => {
                    let title = name
                        .filter(|name| name != &title)
                        .map(|name| format!("{title} [{name}]"))
                        .unwrap_or(title);
                    eprintln!("\x1b[36m[Tool: {} — {}]\x1b[0m", title, status);
                }
                Ok(AcpUpdate::ToolCallUpdate {
                    id: _,
                    status,
                    content,
                    ..
                }) => {
                    if let Some(c) = content {
                        eprintln!("\x1b[36m  {} — {}\x1b[0m", status, c);
                    } else {
                        eprintln!("\x1b[36m  {}\x1b[0m", status);
                    }
                }
                Ok(AcpUpdate::ToolCallUpdateV1 {
                    name,
                    status,
                    display_content,
                    ..
                }) => {
                    let status = status.as_deref().unwrap_or("updated");
                    let status = name
                        .map(|name| format!("{name} — {status}"))
                        .unwrap_or_else(|| status.to_string());
                    if let Some(content) = display_content {
                        eprintln!("\x1b[36m  {} — {}\x1b[0m", status, content);
                    } else {
                        eprintln!("\x1b[36m  {}\x1b[0m", status);
                    }
                }
                Ok(AcpUpdate::PermissionRequest { description, .. }) => {
                    eprintln!("\x1b[33m[Permission] {} (auto-allowed)\x1b[0m", description);
                }
                Ok(AcpUpdate::Complete { .. }) => {
                    println!(); // 换行
                    break;
                }
                Ok(AcpUpdate::CompactionUpdate { update }) => {
                    eprintln!("[Compaction] {}", update.status);
                    if let Some(error) = update.error.value() {
                        eprintln!("{}", error);
                    }
                }
                Ok(AcpUpdate::CompactionSummaryChunk { content, .. }) => {
                    if let crate::acp::ContentBlockData::Text { text } = content {
                        eprint!("{}", text);
                    }
                }
                Ok(AcpUpdate::SessionNotice {
                    severity,
                    title,
                    description,
                }) => {
                    eprintln!(
                        "[{}] {}{}",
                        severity,
                        title,
                        description
                            .map(|value| format!("\n{}", value))
                            .unwrap_or_default()
                    );
                }
                Ok(AcpUpdate::Error { message }) => {
                    eprintln!("\x1b[31mError: {}\x1b[0m", message);
                    break;
                }
                Ok(AcpUpdate::AuthRequired { methods, .. }) => {
                    let hint = methods
                        .first()
                        .map(|m| m.name.as_str())
                        .unwrap_or("<no method advertised>");
                    eprintln!(
                        "\x1b[33m[Auth required: {}] please run `grove web` or this agent's CLI login\x1b[0m",
                        hint
                    );
                    break;
                }
                Ok(AcpUpdate::AuthSucceeded) => continue,
                Ok(AcpUpdate::AuthFailed { message }) => {
                    eprintln!("\x1b[31mError: {}\x1b[0m", message);
                    break;
                }
                Ok(AcpUpdate::AuthLoggedOut) => continue,
                Ok(
                    AcpUpdate::SubagentUpdate { .. }
                    | AcpUpdate::SubagentEvent { .. }
                    | AcpUpdate::SessionMessage { .. }
                    | AcpUpdate::Busy { .. }
                    | AcpUpdate::PromptStarted { .. }
                    | AcpUpdate::InputAccepted { .. }
                    | AcpUpdate::InputRejected { .. }
                    | AcpUpdate::PromptCompleted { .. }
                    | AcpUpdate::PromptFailed { .. }
                    | AcpUpdate::UserMessage { .. }
                    | AcpUpdate::UserMessageTime { .. }
                    | AcpUpdate::TurnInterrupted { .. }
                    | AcpUpdate::ModeChanged { .. }
                    | AcpUpdate::ModelChanged { .. }
                    | AcpUpdate::ThoughtLevelsUpdate { .. }
                    | AcpUpdate::ConfigOptionsUpdate { .. }
                    | AcpUpdate::ConfigOptionError { .. }
                    | AcpUpdate::V2MessageBind { .. }
                    | AcpUpdate::PlanDocumentUpdate { .. }
                    | AcpUpdate::PlanDocumentRemoved { .. }
                    | AcpUpdate::PlanUpdate { .. }
                    | AcpUpdate::AvailableCommands { .. }
                    | AcpUpdate::PermissionResponse { .. }
                    | AcpUpdate::QueueUpdate { .. }
                    | AcpUpdate::QueueMessageGone { .. }
                    | AcpUpdate::QueueEditResult { .. }
                    | AcpUpdate::PlanFileUpdate { .. }
                    | AcpUpdate::TerminalExecute { .. }
                    | AcpUpdate::TerminalChunk { .. }
                    | AcpUpdate::TerminalComplete { .. }
                    | AcpUpdate::TerminalOutputUpdate { .. }
                    | AcpUpdate::ConnectPhase { .. }
                    | AcpUpdate::UsageUpdate { .. }
                    | AcpUpdate::AskForm { .. }
                    | AcpUpdate::ElicitationRequest { .. }
                    | AcpUpdate::ElicitationResolved { .. }
                    | AcpUpdate::ElicitationValidationError { .. }
                    | AcpUpdate::ElicitationComplete { .. },
                ) => continue,
                Ok(AcpUpdate::SessionEnded) => {
                    eprintln!("Session ended.");
                    return;
                }
                Ok(AcpUpdate::SessionReady { .. }) => continue,
                Err(e) => {
                    eprintln!("Channel error: {}", e);
                    return;
                }
            }
        }
    }

    // 清理
    let _ = handle.kill().await;
    eprintln!("Session ended.");
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn v2_snapshots_and_chunks_are_visible_without_repeating_a_prefix() {
        let mut messages = acp::v2_messages::Messages::default();
        let event = |value| serde_json::from_value(value).unwrap();
        let first = event(
            serde_json::json!({"sessionUpdate":"agent_message", "messageId":"m", "content":[{"type":"text","text":"hello"}]}),
        );
        assert_eq!(
            v2_message_delta(&mut messages, &first),
            Some((false, "hello".into()))
        );
        let chunk = event(
            serde_json::json!({"sessionUpdate":"agent_message_chunk", "messageId":"m", "content":{"type":"text","text":" world"}}),
        );
        assert_eq!(
            v2_message_delta(&mut messages, &chunk),
            Some((false, " world".into()))
        );
        let snapshot = event(
            serde_json::json!({"sessionUpdate":"agent_message", "messageId":"m", "content":[{"type":"text","text":"changed"}]}),
        );
        assert_eq!(
            v2_message_delta(&mut messages, &snapshot),
            Some((false, "\nchanged".into()))
        );
    }
}

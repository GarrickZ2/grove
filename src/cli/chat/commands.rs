//! Non-interactive `grove cli` subcommands, for scripts and other agents.

use std::io::{IsTerminal, Read, Write};

use futures::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio_tungstenite::tungstenite::Message;

use super::model::{self, Block, Session};
use super::{api, fail, render, wire, CliArgs, CliCommand, Target};
use crate::cli::chat::conn::Conn;

pub type Socket =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

/// Open the chat socket. `attach_only` observes a live session without
/// starting the agent when it is not running.
pub async fn open_socket(conn: &Conn, target: &Target, attach_only: bool) -> Socket {
    let path = if attach_only {
        format!("{}/ws?attach_only=true", target.chat_path())
    } else {
        format!("{}/ws", target.chat_path())
    };
    conn.websocket(&path).await.unwrap_or_else(|e| fail(e))
}

pub async fn send(socket: &mut Socket, message: Value) {
    if let Err(e) = socket.send(Message::Text(message.to_string().into())).await {
        fail(format!("connection lost: {e}"));
    }
}

/// Next server message, skipping non-JSON frames. `None` when closed.
pub async fn recv(socket: &mut Socket) -> Option<Value> {
    while let Some(frame) = socket.next().await {
        match frame {
            Ok(Message::Text(text)) => {
                if let Ok(value) = serde_json::from_str(&text) {
                    return Some(value);
                }
            }
            Ok(Message::Close(_)) | Err(_) => return None,
            _ => {}
        }
    }
    None
}

async fn target(conn: &Conn, args: &CliArgs, chat_id: Option<&str>, new: bool) -> Target {
    let project = super::resolve_project(conn, &args.target)
        .await
        .unwrap_or_else(|e| fail(e))
        .unwrap_or_else(|| fail("not inside a Grove project; pass --project"));
    let task_id = super::default_task(&args.target);
    let chat_id = chat_id.or(args.target.chat.as_deref());
    let chat = super::resolve_chat(
        conn,
        &project,
        &task_id,
        chat_id,
        new,
        args.agent.as_deref(),
    )
    .await
    .unwrap_or_else(|e| fail(e));
    Target {
        project,
        task_id,
        chat,
    }
}

fn print_block(block: &Block) {
    if let Some(text) = render::plain_text(block) {
        println!("{text}\n");
    }
}

pub async fn run(conn: Conn, args: &CliArgs, command: CliCommand) {
    match command {
        CliCommand::Ls { json } => ls(&conn, args, json).await,
        CliCommand::New { title, json } => {
            let project = super::resolve_project(&conn, &args.target)
                .await
                .unwrap_or_else(|e| fail(e))
                .unwrap_or_else(|| fail("not inside a Grove project; pass --project"));
            let task_id = super::default_task(&args.target);
            let chat = api::create_chat(
                &conn,
                &project.id,
                &task_id,
                args.agent.as_deref(),
                title.as_deref(),
            )
            .await
            .unwrap_or_else(|e| fail(e));
            if json {
                println!(
                    "{}",
                    json!({ "id": chat.id, "title": chat.title, "agent": chat.agent, "task_id": task_id })
                );
            } else {
                println!("{}", chat.id);
            }
        }
        CliCommand::Send {
            message,
            wait,
            json,
        } => send_message(&conn, args, message, wait, json).await,
        CliCommand::Log {
            chat_id,
            follow,
            json,
        } => log(&conn, args, chat_id.as_deref(), follow, json).await,
        CliCommand::Agents { json } => {
            let agents = api::agents(&conn).await.unwrap_or_else(|e| fail(e));
            if json {
                let list: Vec<Value> = agents
                    .iter()
                    .map(|a| json!({ "id": a.id, "name": a.name }))
                    .collect();
                println!("{}", Value::Array(list));
            } else {
                for agent in agents {
                    println!("{:<24} {}", agent.id, agent.name);
                }
            }
        }
    }
}

async fn ls(conn: &Conn, args: &CliArgs, json: bool) {
    let project = super::resolve_project(conn, &args.target)
        .await
        .unwrap_or_else(|e| fail(e))
        .unwrap_or_else(|| fail("not inside a Grove project; pass --project"));
    let active = api::active_chats(conn).await;
    let tasks = match &args.target.task {
        Some(task) => project
            .chat_tasks()
            .into_iter()
            .filter(|t| &t.id == task)
            .collect(),
        None => project.chat_tasks(),
    };
    let mut rows = Vec::new();
    for task in tasks {
        let Ok(chats) = api::chats(conn, &project.id, &task.id).await else {
            continue;
        };
        for chat in chats {
            let state = active
                .get(&chat.id)
                .map(String::as_str)
                .unwrap_or("idle")
                .to_string();
            rows.push((task.clone(), chat, state));
        }
    }
    rows.sort_by(|a, b| b.1.last_active().cmp(a.1.last_active()));
    if json {
        let list: Vec<Value> = rows
            .iter()
            .map(|(task, chat, state)| {
                json!({ "id": chat.id, "title": chat.title, "agent": chat.agent,
                        "task_id": task.id, "task": task.name, "state": state,
                        "updated_at": chat.last_active() })
            })
            .collect();
        println!("{}", Value::Array(list));
        return;
    }
    if rows.is_empty() {
        println!(
            "No sessions in {} yet. Start one with `grove cli`.",
            project.name
        );
        return;
    }
    let color = std::io::stdout().is_terminal();
    println!(
        "{:<10} {:<20} {:<16} {:<12} {:<9} TITLE",
        "ID", "TASK", "AGENT", "STATE", "UPDATED"
    );
    for (task, chat, state) in rows {
        let state_text = match state.as_str() {
            "busy" => "running",
            "permission_required" => "permission",
            _ => "idle",
        };
        let painted = match (color, state_text) {
            (true, "running") => format!("\x1b[34m{state_text:<12}\x1b[0m"),
            (true, "permission") => format!("\x1b[33m{state_text:<12}\x1b[0m"),
            _ => format!("{state_text:<12}"),
        };
        println!(
            "{:<10} {:<20} {:<16} {} {:<9} {}",
            truncate(&chat.id, 10),
            truncate(&task.name, 20),
            truncate(&chat.agent, 16),
            painted,
            ago(chat.last_active()),
            chat.title
        );
    }
}

fn truncate(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        text.to_string()
    } else {
        format!("{}…", text.chars().take(max - 1).collect::<String>())
    }
}

pub fn ago(rfc3339: &str) -> String {
    let Ok(time) = chrono::DateTime::parse_from_rfc3339(rfc3339) else {
        return String::new();
    };
    let seconds = (chrono::Utc::now() - time.with_timezone(&chrono::Utc))
        .num_seconds()
        .max(0);
    match seconds {
        0..=59 => "now".into(),
        60..=3599 => format!("{}m", seconds / 60),
        3600..=86_399 => format!("{}h", seconds / 3600),
        _ => format!("{}d", seconds / 86_400),
    }
}

async fn send_message(
    conn: &Conn,
    args: &CliArgs,
    message: Option<String>,
    wait: bool,
    json: bool,
) {
    let text = match message {
        Some(text) => text,
        None => {
            let mut text = String::new();
            std::io::stdin()
                .read_to_string(&mut text)
                .unwrap_or_else(|e| fail(e));
            text
        }
    };
    let text = text.trim().to_string();
    if text.is_empty() {
        fail("empty message");
    }
    let target = target(conn, args, None, args.new).await;
    let mut socket = open_socket(conn, &target, false).await;
    let mut session = Session::default();
    let id = wire::new_message_id();
    let mut sent = false;
    let mut accepted = false;
    let mut start = 0usize;
    let mut printed = 0usize;
    let interactive = std::io::stderr().is_terminal();

    while let Some(value) = recv(&mut socket).await {
        session.apply(&value);
        match model::kind(&value) {
            // The server answers a connect with `busy` (attach) or
            // `session_ready` (fresh start); either means it can take input.
            "session_ready" | "busy" if !sent => {
                sent = true;
                start = session.blocks.len();
                send(&mut socket, wire::prompt(&text, &id, session.busy, None)).await;
            }
            "input_accepted"
                if value.get("client_message_id").and_then(Value::as_str) == Some(&id) =>
            {
                accepted = true;
                if !wait {
                    println!(
                        "{}",
                        if json {
                            json!({ "chat_id": target.chat.id, "accepted": true }).to_string()
                        } else {
                            target.chat.id.clone()
                        }
                    );
                    return;
                }
                if interactive {
                    eprintln!("sent to {} · {}", target.chat.title, target.chat.agent);
                }
            }
            "input_rejected"
                if value.get("client_message_id").and_then(Value::as_str) == Some(&id) =>
            {
                fail(
                    value
                        .get("message")
                        .and_then(Value::as_str)
                        .unwrap_or("message rejected"),
                );
            }
            "error" if !accepted => fail(
                value
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("error"),
            ),
            "auth_required" => fail(
                "the agent needs you to sign in; open the session with `grove cli` or the web UI",
            ),
            "remote_session" => fail("this session is owned by another Grove process"),
            "complete" | "turn_interrupted" if accepted => {
                if let Some(form) = session.forms.first() {
                    eprintln!(
                        "the agent asked: {} — answer it in `grove cli` or the web UI",
                        form.title
                    );
                }
                let reply: Vec<&Block> = session.blocks[start..].iter().collect();
                if json {
                    let text: String = reply
                        .iter()
                        .filter_map(|b| match b {
                            Block::Agent { text, .. } => Some(text.trim().to_string()),
                            _ => None,
                        })
                        .collect::<Vec<_>>()
                        .join("\n\n");
                    println!(
                        "{}",
                        json!({ "chat_id": target.chat.id, "interrupted": model::kind(&value) == "turn_interrupted", "reply": text })
                    );
                } else {
                    for block in &session.blocks[start + printed..] {
                        if !matches!(block, Block::User { .. }) {
                            print_block(block);
                        }
                    }
                }
                return;
            }
            _ => {}
        }
        // Stream settled blocks as they finish.
        if wait && accepted && !json {
            while start + printed < session.blocks.len() && session.settled(start + printed) {
                if !matches!(session.blocks[start + printed], Block::User { .. }) {
                    print_block(&session.blocks[start + printed]);
                }
                printed += 1;
            }
            let _ = std::io::stdout().flush();
        }
        if let Some(permission) = session.permission.as_ref().filter(|_| wait && interactive) {
            eprintln!(
                "waiting for permission: {} — answer it in `grove cli` or the web UI",
                permission.description
            );
        }
        if model::kind(&value) == "elicitation_request" && wait {
            if let Some(form) = session.forms.last() {
                eprintln!(
                    "the agent is waiting on a question: {} — answer it in `grove cli` or the web UI",
                    form.title
                );
            }
        }
    }
    fail("connection closed before the agent finished");
}

async fn log(conn: &Conn, args: &CliArgs, chat_id: Option<&str>, follow: bool, json: bool) {
    let target = target(conn, args, chat_id, false).await;
    let history = api::history(
        conn,
        &target.project.id,
        &target.task_id,
        &target.chat.id,
        0,
    )
    .await
    .unwrap_or_else(|e| fail(e));
    if json && !follow {
        println!(
            "{}",
            json!({ "chat_id": target.chat.id, "events": history.events })
        );
        return;
    }
    let mut session = Session::default();
    let mut printed = 0usize;
    for event in &history.events {
        if json {
            println!("{event}");
        } else {
            session.apply(event);
        }
    }
    session.finish_replay(false, false);
    if !json {
        for block in &session.blocks {
            print_block(block);
        }
        printed = session.blocks.len();
    }
    if !follow || !history.runtime.active {
        return;
    }
    let mut socket = open_socket(conn, &target, true).await;
    session.busy = history.runtime.busy.unwrap_or(false);
    while let Some(value) = recv(&mut socket).await {
        if json {
            println!("{value}");
            continue;
        }
        session.apply(&value);
        while printed < session.blocks.len() && session.settled(printed) {
            print_block(&session.blocks[printed]);
            printed += 1;
        }
        let _ = std::io::stdout().flush();
        if session.ended {
            break;
        }
    }
}

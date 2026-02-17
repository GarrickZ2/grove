//! `grove acp <agent>` — 交互式 ACP 聊天测试工具

use std::collections::HashMap;
use std::io::{self, BufRead, Write};
use std::path::PathBuf;

use crate::acp::{self, AcpStartConfig, AcpUpdate};

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
        agent_args: resolved.args,
        working_dir,
        env_vars: HashMap::new(),
        project_key: String::new(),
        task_id: String::new(),
        chat_id: None,
        agent_type: resolved.agent_type,
        remote_url: resolved.url,
        remote_auth: resolved.auth_header,
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
        if let Err(e) = handle_for_input.send_prompt(text).await {
            eprintln!("Failed to send prompt: {}", e);
            break;
        }

        // 读取流式响应直到 Complete 或 Error
        loop {
            match update_rx.recv().await {
                Ok(AcpUpdate::MessageChunk { text }) => {
                    print!("{}", text);
                    io::stdout().flush().ok();
                }
                Ok(AcpUpdate::ThoughtChunk { text }) => {
                    // 灰色打印思考过程
                    eprint!("\x1b[90m{}\x1b[0m", text);
                    io::stderr().flush().ok();
                }
                Ok(AcpUpdate::ToolCall { id: _, title, .. }) => {
                    eprintln!("\x1b[36m[Tool: {}]\x1b[0m", title);
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
                Ok(AcpUpdate::PermissionRequest { description, .. }) => {
                    eprintln!("\x1b[33m[Permission] {} (auto-allowed)\x1b[0m", description);
                }
                Ok(AcpUpdate::Complete { stop_reason: _ }) => {
                    println!(); // 换行
                    break;
                }
                Ok(AcpUpdate::Error { message }) => {
                    eprintln!("\x1b[31mError: {}\x1b[0m", message);
                    break;
                }
                Ok(
                    AcpUpdate::Busy(_)
                    | AcpUpdate::UserMessage { .. }
                    | AcpUpdate::ModeChanged { .. }
                    | AcpUpdate::PlanUpdate { .. }
                    | AcpUpdate::AvailableCommands { .. },
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

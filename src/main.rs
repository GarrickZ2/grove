mod api;
mod app;
mod check;
mod cli;
mod difit;
mod event;
mod git;
mod hooks;
mod model;
mod session;
mod storage;
mod theme;
mod tmux;
mod ui;
mod update;
mod watcher;
mod zellij;

use std::io::{self, Write};
use std::panic;
use std::time::Instant;

use clap::Parser;
use crossterm::event::{DisableMouseCapture, EnableMouseCapture};
use crossterm::execute;
use ratatui::DefaultTerminal;

use app::{App, AppMode};
use cli::{Cli, Commands};

/// Auto-refresh interval in seconds
const AUTO_REFRESH_INTERVAL_SECS: u64 = 5;

fn main() -> io::Result<()> {
    // Set up panic hook to restore terminal state on panic
    let original_hook = panic::take_hook();
    panic::set_hook(Box::new(move |panic_info| {
        // Restore terminal state
        let _ = execute!(io::stdout(), DisableMouseCapture);
        ratatui::restore();
        // Call the original panic hook
        original_hook(panic_info);
    }));
    // 解析命令行参数
    let cli = Cli::parse();

    // 如果有子命令，执行 CLI 逻辑
    if let Some(command) = cli.command {
        match command {
            Commands::Hooks { level } => {
                cli::hooks::execute(level);
            }
            Commands::Mcp => {
                // MCP server requires tokio runtime
                tokio::runtime::Runtime::new()
                    .expect("Failed to create tokio runtime")
                    .block_on(async {
                        if let Err(e) = cli::mcp::run_mcp_server().await {
                            eprintln!("MCP server error: {}", e);
                            std::process::exit(1);
                        }
                    });
            }
            Commands::Fp => {
                cli::fp::execute();
            }
            Commands::Web { port, no_open, dev } => {
                tokio::runtime::Runtime::new()
                    .expect("Failed to create tokio runtime")
                    .block_on(async {
                        cli::web::execute(port, no_open, dev).await;
                    });
            }
            Commands::Gui { port } => {
                #[cfg(feature = "gui")]
                {
                    tokio::runtime::Runtime::new()
                        .expect("Failed to create tokio runtime")
                        .block_on(async {
                            cli::gui::execute(port).await;
                        });
                }
                #[cfg(not(feature = "gui"))]
                {
                    let _ = port; // suppress unused warning
                    eprintln!("GUI mode is not available in this build.");
                    eprintln!();
                    eprintln!("To enable GUI support, rebuild with the 'gui' feature:");
                    eprintln!("  cargo build --release --features gui");
                    eprintln!();
                    eprintln!("Or install with GUI support:");
                    eprintln!("  cargo install grove-rs --features gui");
                    std::process::exit(1);
                }
            }
        }
        return Ok(());
    }

    // 否则启动 TUI
    // 环境检查
    let result = check::check_environment();
    if !result.ok {
        eprintln!("Grove requires the following dependencies:\n");
        for err in &result.errors {
            eprintln!("  ✗ {}", err);
        }
        eprintln!("\nPlease install the missing dependencies and try again.");
        std::process::exit(1);
    }

    // 初始化终端
    let mut terminal = ratatui::init();
    execute!(io::stdout(), EnableMouseCapture)?;

    // 创建应用
    let mut app = App::new();

    // 运行主循环
    let result = run(&mut terminal, &mut app);

    // 恢复终端
    execute!(io::stdout(), DisableMouseCapture)?;
    ratatui::restore();

    // 清除终端 tab 标题（恢复默认）
    print!("\x1b]0;\x07");
    let _ = io::stdout().flush();

    result
}

fn run(terminal: &mut DefaultTerminal, app: &mut App) -> io::Result<()> {
    let mut last_refresh = Instant::now();

    loop {
        // 检查是否有待 attach 的 session
        if let Some(att) = app.pending_attach.take() {
            // 暂停 TUI
            execute!(io::stdout(), DisableMouseCapture)?;
            ratatui::restore();

            // attach 到 session（阻塞，直到用户 detach）
            let _ = session::attach_session(
                &att.multiplexer,
                &att.session,
                Some(&att.working_dir),
                Some(&att.env),
                att.layout_path.as_deref(),
            );

            // 清除 tmux detach 消息（只清除一行，仅 tmux 需要）
            if att.multiplexer == storage::config::Multiplexer::Tmux {
                print!("\x1b[1A\x1b[2K\r");
                let _ = io::stdout().flush();
            }

            // 恢复 TUI
            *terminal = ratatui::init();
            execute!(io::stdout(), EnableMouseCapture)?;

            // 刷新数据（用户可能在 session 中做了改动）
            app.refresh();
            // 刷新后再清除 hook 通知，避免 refresh 覆盖清除结果
            app.clear_task_hook_by_session(&att.session);
            last_refresh = Instant::now();
        }

        // 检查是否有待打开的外部编辑器（Monitor 模式）
        if let Some(file_path) = app.monitor.pending_notes_edit.take() {
            // 暂停 TUI
            execute!(io::stdout(), DisableMouseCapture)?;
            ratatui::restore();

            // 打开外部编辑器
            let editor = std::env::var("EDITOR").unwrap_or_else(|_| "vim".to_string());
            let _ = std::process::Command::new(&editor).arg(&file_path).status();

            // 恢复 TUI
            *terminal = ratatui::init();
            execute!(io::stdout(), EnableMouseCapture)?;

            // 重新加载 notes 内容
            app.monitor.refresh_panel_data();
        }

        // 检查是否有待打开的外部编辑器（Project 模式）
        if let Some(file_path) = app.project.pending_notes_edit.take() {
            // 暂停 TUI
            execute!(io::stdout(), DisableMouseCapture)?;
            ratatui::restore();

            // 打开外部编辑器
            let editor = std::env::var("EDITOR").unwrap_or_else(|_| "vim".to_string());
            let _ = std::process::Command::new(&editor).arg(&file_path).status();

            // 恢复 TUI
            *terminal = ratatui::init();
            execute!(io::stdout(), EnableMouseCapture)?;

            // 重新加载 notes 内容
            app.project.refresh_panel_data();
        }

        // 定时自动刷新（每 5 秒）
        if last_refresh.elapsed().as_secs() >= AUTO_REFRESH_INTERVAL_SECS {
            app.refresh();
            // 同时刷新面板数据
            if app.mode == AppMode::Project && app.project.preview_visible {
                app.project.refresh_panel_data();
            }
            // Monitor 模式自动刷新
            if app.mode == AppMode::Monitor {
                app.monitor.refresh_panel_data();
            }
            last_refresh = Instant::now();
        }

        // 检查后台操作结果
        app.poll_bg_result();

        // 渲染界面
        app.click_areas.reset();
        terminal.draw(|frame| match app.mode {
            AppMode::Workspace => ui::workspace::render(frame, app),
            AppMode::Project => ui::project::render(frame, app),
            AppMode::Monitor => ui::monitor::render(frame, app),
        })?;

        // 处理事件
        if !event::handle_events(app)? {
            break;
        }
    }

    Ok(())
}

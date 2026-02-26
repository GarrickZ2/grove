mod acp;
mod api;
mod app;
mod async_ops_state;
mod check;
mod cli;
mod config_state;
mod dialogs;
mod diff;
mod error;
mod event;
mod git;
mod hooks;
mod model;
mod notification_state;
mod operations;
mod session;
mod storage;
mod theme;
mod tmux;
mod ui;
mod ui_state;
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

/// Check storage version and auto-migrate if needed
fn ensure_storage_version() {
    let config = storage::config::load_config();
    match config.storage_version.as_deref() {
        Some("1.1") => {} // Up to date
        Some("1.0") => {
            // Migrate from 1.0 to 1.1
            eprintln!(
                "Migrating storage from v1.0 to v1.1 (task_modes → enable_terminal/enable_chat)..."
            );
            cli::migrate::execute(false);
        }
        None => {
            // Legacy or fresh install - run full migration
            if storage::grove_dir().join("projects").exists() {
                eprintln!("Migrating storage to v1.1...");
                cli::migrate::execute(false);
            } else {
                // Fresh install, set version directly
                let mut config = config;
                config.storage_version = Some("1.1".to_string());
                let _ = storage::config::save_config(&config);
            }
        }
        Some(v) => {
            eprintln!("Unknown storage version: {}. Expected 1.1.", v);
            eprintln!("Please run: grove migrate");
            std::process::exit(1);
        }
    }
}

/// 启动 TUI 界面
fn run_tui() -> io::Result<()> {
    ensure_storage_version();

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

fn main() -> io::Result<()> {
    // Enable backtraces by default so panics show call stacks
    if std::env::var("RUST_BACKTRACE").is_err() {
        // SAFETY: called at the very start of main, before any other threads
        unsafe {
            std::env::set_var("RUST_BACKTRACE", "1");
        }
    }

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

    // 确定要执行的命令
    let (command, from_replay) = match cli.command {
        Some(cmd) => (cmd, false),
        None => {
            // 无子命令：重放上次启动模式，默认 TUI
            let config = storage::config::load_config();
            match config.last_launch {
                Some(ref ll) => {
                    let label = ll.display_label();
                    if !matches!(ll, storage::config::LastLaunch::Tui) {
                        eprintln!("grove → grove {}", label);
                    }
                    (ll.to_command(), true)
                }
                None => (Commands::Tui, true),
            }
        }
    };

    // 如果是新的启动模式命令（非重放），保存到配置
    if !from_replay {
        if let Some(last_launch) = command.to_last_launch() {
            let mut config = storage::config::load_config();
            config.last_launch = Some(last_launch);
            let _ = storage::config::save_config(&config);
        }
    }

    // 统一调度
    match command {
        Commands::Tui => {
            run_tui()?;
        }
        Commands::Hooks { level } => {
            cli::hooks::execute(level);
        }
        Commands::Mcp => {
            ensure_storage_version();
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
        Commands::Web { port, host, no_open, dev } => {
            ensure_storage_version();
            tokio::runtime::Runtime::new()
                .expect("Failed to create tokio runtime")
                .block_on(async {
                    cli::web::execute(port, &host.to_string(), no_open, dev).await;
                });
        }
        Commands::Mobile {
            port,
            no_open,
            tls,
            cert,
            key,
            host,
            public,
        } => {
            ensure_storage_version();
            tokio::runtime::Runtime::new()
                .expect("Failed to create tokio runtime")
                .block_on(async {
                    cli::web::execute_mobile(port, no_open, tls, cert, key, host, public).await;
                });
        }
        Commands::Diff { task_id, port } => {
            cli::diff::execute(task_id, port);
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
                let _ = port;
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
        Commands::Acp { agent, cwd } => {
            ensure_storage_version();
            tokio::runtime::Runtime::new()
                .expect("Failed to create tokio runtime")
                .block_on(async {
                    let local = tokio::task::LocalSet::new();
                    local.run_until(cli::acp::execute(agent, cwd)).await;
                });
        }
        Commands::Migrate { dry_run } => {
            cli::migrate::execute(dry_run);
        }
    }

    Ok(())
}

fn run(terminal: &mut DefaultTerminal, app: &mut App) -> io::Result<()> {
    let mut last_refresh = Instant::now();

    loop {
        // 检查是否有待 attach 的 session
        if let Some(att) = app.async_ops.pending_attach.take() {
            // 暂停 TUI
            execute!(io::stdout(), DisableMouseCapture)?;
            ratatui::restore();

            // attach 到 session（阻塞，直到用户 detach）
            let _ = session::attach_session(
                &att.session_type,
                &att.session,
                Some(&att.working_dir),
                Some(&att.env),
                att.layout_path.as_deref(),
            );

            // 清除 tmux detach 消息（只清除一行，仅 tmux 需要）
            if matches!(att.session_type, session::SessionType::Tmux) {
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
        app.ui.click_areas.reset();
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

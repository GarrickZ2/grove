mod acp;
mod agent_graph;
mod agent_usage;
mod api;
#[cfg(not(windows))]
mod app;
#[cfg(not(windows))]
mod async_ops_state;
mod check;
mod cli;
#[cfg(not(windows))]
mod config_state;
#[cfg(not(windows))]
mod dialogs;
mod diff;
mod error;
#[cfg(not(windows))]
mod event;
mod fs_link;
mod git;
mod hooks;
mod model;
#[cfg(not(windows))]
mod notification_state;
mod operations;
mod session;
mod stats;
mod storage;
mod symbols;
#[cfg(not(windows))]
mod theme;
mod tmux;
#[cfg(feature = "gui")]
mod tray;
#[cfg(not(windows))]
mod ui;
#[cfg(not(windows))]
mod ui_state;
mod update;
mod watcher;
mod zellij;

use std::io::{self, Write};
use std::panic;
use std::time::Instant;

use clap::Parser;
#[cfg(not(windows))]
use crossterm::event::{DisableMouseCapture, EnableMouseCapture};
#[cfg(not(windows))]
use crossterm::execute;
#[cfg(not(windows))]
use ratatui::DefaultTerminal;

#[cfg(not(windows))]
use app::{App, AppMode};
use cli::{Cli, Commands};

/// Auto-refresh interval in seconds
const AUTO_REFRESH_INTERVAL_SECS: u64 = 5;

/// Check storage version and auto-migrate if needed
fn ensure_storage_version() {
    use storage::database::CURRENT_STORAGE_VERSION;

    let config = storage::config::load_config();
    let version = config.storage_version.as_deref();

    if version == Some(CURRENT_STORAGE_VERSION) {
        // Up to date — just ensure DB is initialized
        let _ = storage::database::connection();
        storage::database::run_agent_graph_startup_maintenance();
        return;
    }

    let has_legacy_files = storage::grove_dir().join("projects").exists()
        || storage::grove_dir().join("taskgroups.toml").exists()
        || storage::grove_dir().join("ai").exists()
        || storage::grove_dir()
            .join("skills")
            .join("agents.toml")
            .exists();

    // Chain migrations: None/1.0 → 1.1 → 2.0 → 2.1 → 2.2 → 2.3 → 2.4
    match version {
        Some("1.0") | None => {
            if has_legacy_files {
                if storage::grove_dir().join("projects").exists() {
                    eprintln!("Migrating storage v1.0 → v1.1...");
                    cli::migrate::execute(false);
                }
                eprintln!("Migrating storage v1.1 → v2.0 (SQLite)...");
                storage::database::migrate_from_files();
            } else {
                let _ = storage::database::connection();
            }
        }
        Some("1.1") => {
            if has_legacy_files {
                eprintln!("Migrating storage v1.1 → v2.0 (SQLite)...");
                storage::database::migrate_from_files();
            } else {
                let _ = storage::database::connection();
            }
        }
        Some("2.0") => {
            if storage::database::migrate_v20_fix_empty_slots() {
                eprintln!("Migrating storage v2.0 → v2.1...");
            }
        }
        Some("2.1") => {
            // v2.1 → v2.2: Agent Graph schema + chats.toml migration
            let _ = storage::database::connection();
        }
        Some("2.2") => {
            // v2.2 → v2.3: Review comments JSON → SQLite
            let _ = storage::database::connection();
        }
        Some("2.3") => {
            // v2.3 → v2.4: Tasks TOML → SQLite
            let _ = storage::database::connection();
        }
        Some(v) => {
            eprintln!(
                "Unknown storage version: {}. Expected {}.",
                v, CURRENT_STORAGE_VERSION
            );
            std::process::exit(1);
        }
    }

    // v2.3: Review comments JSON → SQLite. Idempotent (INSERT OR IGNORE) — run for any
    // pre-2.3 user so that those upgrading from 1.0/1.1/2.0/2.1 don't skip it.
    if version != Some(CURRENT_STORAGE_VERSION) {
        storage::database::migrate_review_to_sqlite();
    }

    // v2.4: Tasks TOML → SQLite. Idempotent (INSERT OR IGNORE, gated by row count).
    if version != Some(CURRENT_STORAGE_VERSION) {
        storage::database::migrate_tasks_toml_to_sqlite();
    }

    // Update version
    let mut config = storage::config::load_config();
    config.storage_version = Some(CURRENT_STORAGE_VERSION.to_string());
    let _ = storage::config::save_config(&config);

    storage::database::run_agent_graph_startup_maintenance();
}

/// 启动 TUI 界面
#[cfg(not(windows))]
fn run_tui() -> io::Result<()> {
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

    #[cfg(feature = "perf-monitor")]
    api::perf_tracing::install();

    // Set up panic hook to restore terminal state on panic (TUI only)
    #[cfg(not(windows))]
    let original_hook = panic::take_hook();
    #[cfg(not(windows))]
    panic::set_hook(Box::new(move |panic_info| {
        let _ = execute!(io::stdout(), DisableMouseCapture);
        ratatui::restore();
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

            // AppBundle 环境下，始终强制进入 GUI 模式
            // （忽略 last_launch 中可能存的 Web/Tui，仅保留上次记录的 GUI 端口）
            #[cfg(feature = "gui")]
            if matches!(
                update::detect_install_method(),
                update::InstallMethod::AppBundle
            ) {
                let port = config
                    .last_launch
                    .as_ref()
                    .and_then(|ll| {
                        if let storage::config::LastLaunch::Gui { port } = ll {
                            Some(*port)
                        } else {
                            None
                        }
                    })
                    .unwrap_or(3001);
                return {
                    let (command, from_replay) = (Commands::Gui { port }, false);
                    // 保存 last_launch
                    if let Some(last_launch) = command.to_last_launch() {
                        let mut cfg = storage::config::load_config();
                        cfg.last_launch = Some(last_launch);
                        let _ = storage::config::save_config(&cfg);
                    }
                    // 直接执行 GUI
                    tokio::runtime::Runtime::new()
                        .expect("Failed to create tokio runtime")
                        .block_on(async {
                            cli::gui::execute(if let Commands::Gui { port } = command {
                                port
                            } else {
                                3001
                            })
                            .await;
                        });
                    let _ = from_replay;
                    Ok(())
                };
            }

            // 非 AppBundle：重放上次启动模式，默认 TUI
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

    // Ensure storage is migrated and DB initialized for UI commands
    let needs_storage = matches!(
        command,
        Commands::Tui | Commands::Web { .. } | Commands::Mobile { .. } | Commands::Gui { .. }
    );
    if needs_storage {
        ensure_storage_version();
        // 一次性地把当前工作目录(若为 git 仓库)登记成 project。
        // 旧逻辑放在 GET /projects handler 里,每次请求要 80ms+,纯属浪费。
        storage::workspace::auto_register_cwd_if_git_repo();
    }

    // 统一调度
    match command {
        Commands::Tui => {
            #[cfg(windows)]
            {
                eprintln!("grove tui is not supported on Windows. Please use WSL2 or run `grove web` instead.");
                std::process::exit(1);
            }
            #[cfg(not(windows))]
            run_tui()?;
        }
        Commands::Hooks { level } => {
            cli::hooks::execute(level);
        }
        Commands::Mcp => {
            tokio::runtime::Runtime::new()
                .expect("Failed to create tokio runtime")
                .block_on(async {
                    if let Err(e) = cli::mcp::run_mcp_server().await {
                        eprintln!("MCP server error: {}", e);
                        std::process::exit(1);
                    }
                });
        }
        Commands::McpBridge => {
            std::process::exit(cli::mcp_bridge::run());
        }
        Commands::Fp => {
            #[cfg(windows)]
            {
                eprintln!("grove fp is not supported on Windows. Please use WSL2.");
                std::process::exit(1);
            }
            #[cfg(not(windows))]
            cli::fp::execute();
        }
        Commands::Web { port, no_open, dev } => {
            tokio::runtime::Runtime::new()
                .expect("Failed to create tokio runtime")
                .block_on(async {
                    cli::web::execute(port, no_open, dev).await;
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
            private,
        } => {
            tokio::runtime::Runtime::new()
                .expect("Failed to create tokio runtime")
                .block_on(async {
                    cli::web::execute_mobile(port, no_open, tls, cert, key, host, public, private)
                        .await;
                });
        }
        Commands::Diff { task_id, port } => {
            cli::diff::execute(task_id, port);
        }
        Commands::Gui { port } => {
            #[cfg(feature = "gui")]
            {
                // When launched from CLI (not AppBundle), daemonize so the
                // terminal is released immediately.  The child re-execs itself
                // with GROVE_GUI_DAEMON=1 and runs the actual GUI.
                if cli::gui::try_daemonize(port) {
                    return Ok(()); // parent exits, child runs in background
                }

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
            tokio::runtime::Runtime::new()
                .expect("Failed to create tokio runtime")
                .block_on(async {
                    let local = tokio::task::LocalSet::new();
                    local.run_until(cli::acp::execute(agent, cwd)).await;
                });
        }
        Commands::Migrate { prune } => {
            if prune {
                storage::database::prune_legacy_files();
            } else {
                // Run the exact same migration chain as startup. The legacy
                // v1.0 → v1.1 file rearranger (`cli::migrate::execute`) is one
                // step inside that chain, but it's no longer the whole story —
                // SQLite-era migrations (v1.1 → v2.0, v2.2 → v2.3, …) only run
                // through `ensure_storage_version`, so calling that function
                // directly is the only way to keep manual `grove migrate` and
                // automatic startup migration in sync.
                ensure_storage_version();
            }
        }
        Commands::Register { path } => {
            let path = path.unwrap_or_else(|| {
                std::env::current_dir()
                    .expect("Failed to get current directory")
                    .to_string_lossy()
                    .to_string()
            });
            let name = std::path::Path::new(&path)
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| path.clone());
            match storage::workspace::upsert_project(&name, &path) {
                Ok(()) => println!("Registered project: {} ({})", name, path),
                Err(e) => {
                    eprintln!("Failed to register project: {}", e);
                    std::process::exit(1);
                }
            }
        }
        Commands::Remove { path } => {
            let path = path.unwrap_or_else(|| {
                std::env::current_dir()
                    .expect("Failed to get current directory")
                    .to_string_lossy()
                    .to_string()
            });
            // Resolve to main repo path (handles worktrees)
            let resolved = git::repo_root(&path)
                .and_then(|root| git::get_main_repo_path(&root).or(Ok(root)))
                .unwrap_or_else(|_| path.clone());
            match storage::workspace::remove_project(&resolved) {
                Ok(()) => println!("Removed project: {}", resolved),
                Err(e) => {
                    eprintln!("Failed to remove project: {}", e);
                    std::process::exit(1);
                }
            }
        }
    }

    Ok(())
}

#[cfg(not(windows))]
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

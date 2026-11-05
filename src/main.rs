mod acp;
mod agent_config;
mod agent_graph;
mod agent_usage;
mod api;
mod app_icons;
mod automation;
mod buddy;
mod check;
mod cli;
mod connect;
mod diff;
mod error;
mod fs_link;
mod git;
mod grove;
mod hooks;
mod machines;
mod mcp_client;
mod memory;
mod model;
mod notification_renderer;
mod operations;
mod plugins;
pub(crate) mod radio;
mod session;
mod session_scope;
mod speech;
mod stats;
mod storage;
mod symbols;
mod theme;
mod tmux;
#[cfg(feature = "gui")]
mod tray;
mod update;
mod watcher;
mod zellij;

use std::io;

use clap::Parser;

use cli::{Cli, Commands};

/// Check storage version and auto-migrate if needed
fn ensure_storage_version() {
    use storage::database::CURRENT_STORAGE_VERSION;

    let config = storage::config::load_config();
    let version = config.storage_version.as_deref();

    if version == Some(CURRENT_STORAGE_VERSION) {
        // Up to date — just ensure DB is initialized
        let _ = storage::database::connection();
        storage::database::run_agent_graph_startup_maintenance();
        if let Err(e) = storage::curated_agents::ensure_curated_file() {
            eprintln!("[startup] failed to update curated agents file: {}", e);
        }
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
        Some("2.4") => {
            // v2.4 → v2.5: Cost columns added
            let _ = storage::database::connection();
        }
        Some("2.5") => {
            // v2.5 → v2.6: TWO things land together —
            //   1. one-time agent id remap (legacy → canonical, e.g. claude
            //      → claude-acp); idempotent via the audit table.
            //   2. installed_agents schema reshape into multi-installation
            //      JSON form; idempotent via sqlite_master inspection.
            // Order matters: remap rewrites the OLD-shape rows by id
            // before the schema reshape reads them out.
            let _ = storage::database::connection();
            storage::database::migrate_installed_agents_id_remap();
        }
        Some("2.6") => {
            // v2.6 → v2.7: Migrate audio settings from SQLite to config.toml
            let _ = storage::database::connection();
            storage::database::migrate_audio_to_config_toml();
        }
        Some("2.7") => {
            // v2.7 → v2.8: Standard-cron weekday semantics are adapted to
            // the backend cron crate; refresh persisted future fire times.
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

    // v2.6: One-time agent id remap (legacy → canonical). Idempotent
    // (skip via installed_agents_id_remap). Runs on every upgrade so a
    // user skipping from 1.0 directly to 2.6 also gets the work done.
    if version != Some(CURRENT_STORAGE_VERSION) {
        storage::database::migrate_installed_agents_id_remap();
    }

    // v2.6: installed_agents schema reshape (one row per agent,
    // multi-installation JSON column). Idempotent (detected by
    // sqlite_master inspection). Runs AFTER the id remap above so the
    // reshape sees canonical ids.
    if version != Some(CURRENT_STORAGE_VERSION) {
        if let Err(e) = storage::database::migrate_installed_agents_to_v26() {
            eprintln!("[migrate] installed_agents v2.6 failed: {}", e);
        }
    }

    // v2.6: canonicalize the agent id in config.toml (acp.agent_command).
    // Idempotent — once everything is canonical
    // it's a silent no-op.
    if version != Some(CURRENT_STORAGE_VERSION) {
        storage::database::migrate_config_agent_command_ids();
    }

    // v2.8: `schedule_cron` remains standard 5-field cron. Recompute the
    // derived timestamps after fixing the backend library's weekday mapping.
    if version != Some(CURRENT_STORAGE_VERSION) {
        match storage::automations::recompute_all_next_runs() {
            Ok(count) if count > 0 => {
                eprintln!("[migrate] refreshed {} automation schedule(s)", count)
            }
            Ok(_) => {}
            Err(error) => eprintln!(
                "[migrate] failed to refresh automation schedules: {}",
                error
            ),
        }
    }

    // Update version
    let mut config = storage::config::load_config();
    config.storage_version = Some(CURRENT_STORAGE_VERSION.to_string());
    let _ = storage::config::save_config(&config);

    storage::database::run_agent_graph_startup_maintenance();

    // Curated agent list — idempotent first-launch copy. On every boot we
    // make sure `~/.grove/builtin-agents/curated.json` exists; if it
    // doesn't, we drop the embedded default there. The marketplace modal
    // reads this file to render its default landing view.
    if let Err(e) = storage::curated_agents::ensure_curated_file() {
        eprintln!("[startup] failed to bootstrap curated agents file: {}", e);
    }
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

    // 解析命令行参数
    let cli = Cli::parse();

    // 确定要执行的命令
    let (command, from_replay) = match cli.command {
        Some(cmd) => (cmd, false),
        None => {
            // 无子命令：重放上次启动模式，默认 TUI
            let mut config = storage::config::load_config();
            // Remote clients take their destination explicitly from the CLI,
            // never from a local launch preference left by an older release.
            config.last_launch = config
                .last_launch
                .filter(|launch| launch.to_command().needs_local_storage());

            // AppBundle 环境下，始终强制进入 GUI 模式
            // （忽略 last_launch 中可能存的 Web/Tui，仅保留上次记录的 GUI 端口）
            #[cfg(feature = "gui")]
            if matches!(
                update::detect_install_method(),
                update::InstallMethod::AppBundle
            ) {
                let (port, remote_url) = config
                    .last_launch
                    .as_ref()
                    .and_then(|ll| {
                        if let storage::config::LastLaunch::Gui { port, remote_url } = ll {
                            Some((*port, remote_url.clone()))
                        } else {
                            None
                        }
                    })
                    .unwrap_or((3001, None));
                return {
                    let (command, from_replay) = (
                        Commands::Gui {
                            port,
                            remote_url: remote_url.clone(),
                        },
                        false,
                    );
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
                            cli::gui::execute(port, remote_url).await;
                        });
                    let _ = from_replay;
                    Ok(())
                };
            }

            // 非 AppBundle：终端里给一个启动面板（Recent / Web / App / CLI /
            // Server）；被脚本调用时重放上次启动模式，默认 TUI
            use std::io::IsTerminal;
            if io::stdin().is_terminal() && io::stdout().is_terminal() {
                match cli::launcher::choose(config.last_launch.as_ref()) {
                    Some(choice) => choice,
                    None => return Ok(()),
                }
            } else {
                match config.last_launch {
                    Some(ref ll) => {
                        let label = ll.display_label();
                        if !matches!(ll, storage::config::LastLaunch::Tui) {
                            eprintln!("grove → grove {}", label);
                        }
                        (ll.to_command(), true)
                    }
                    None => (Commands::Tui { remote: None }, true),
                }
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
    if command.needs_local_storage() {
        // Check for updates at CLI startup and prompt user to auto-update
        let config = storage::config::load_config();
        let update_info = update::check_for_updates(
            config.update.latest_version.as_deref(),
            config.update.last_check.as_deref(),
        );

        // If a new check was performed, save the results to the config cache
        if update::should_check(config.update.last_check.as_deref()) {
            if let Some(ref check_time) = update_info.check_time {
                let mut new_config = config.clone();
                new_config.update.last_check = Some(check_time.to_rfc3339());
                new_config.update.latest_version = update_info.latest_version.clone();
                let _ = storage::config::save_config(&new_config);
            }
        }

        // A background `grove serve` has no one to answer the prompt.
        if update_info.has_update() && !matches!(command, Commands::Serve { .. }) {
            update::prompt_and_execute_update(&update_info);
        }

        ensure_storage_version();
        // 一次性地把当前工作目录(若为 git 仓库)登记成 project。
        // 旧逻辑放在 GET /projects handler 里,每次请求要 80ms+,纯属浪费。
        storage::workspace::auto_register_cwd_if_git_repo();
    }

    // 统一调度
    match command {
        Commands::Tui { remote } => {
            tokio::runtime::Runtime::new()
                .expect("Failed to create tokio runtime")
                .block_on(cli::chat::run_app(remote));
        }
        Commands::Upgrade => {
            if let Err(error) = update::upgrade() {
                eprintln!("Upgrade failed: {error}");
                std::process::exit(1);
            }
        }
        Commands::Device {
            command: cli::DeviceCommand::Ios,
        } => {
            if let Err(error) = cli::ios::execute() {
                eprintln!("iOS download: {error}");
                std::process::exit(1);
            }
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
        Commands::McpBridge { route } => {
            std::process::exit(cli::mcp_bridge::run(route));
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
        Commands::Web {
            port,
            no_open,
            dev,
            remote_url,
        } => {
            tokio::runtime::Runtime::new()
                .expect("Failed to create tokio runtime")
                .block_on(async {
                    cli::web::execute(port, no_open, dev, remote_url).await;
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
        Commands::Gui { port, remote_url } => {
            #[cfg(feature = "gui")]
            {
                // When launched from CLI (not AppBundle), daemonize so the
                // terminal is released immediately.  The child re-execs itself
                // with GROVE_GUI_DAEMON=1 and runs the actual GUI.
                if cli::gui::try_daemonize(port, remote_url.as_deref()) {
                    return Ok(()); // parent exits, child runs in background
                }

                tokio::runtime::Runtime::new()
                    .expect("Failed to create tokio runtime")
                    .block_on(async {
                        cli::gui::execute(port, remote_url).await;
                    });
            }
            #[cfg(not(feature = "gui"))]
            {
                let _ = (port, remote_url);
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
        Commands::Cli(args) => {
            tokio::runtime::Runtime::new()
                .expect("Failed to create tokio runtime")
                .block_on(cli::chat::execute(args));
        }
        Commands::Serve { port } => {
            tokio::runtime::Runtime::new()
                .expect("Failed to create tokio runtime")
                .block_on(cli::web::execute(port, true, false, None));
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
            // Resolve "." / ".." / relative paths against current_dir so that
            // `file_name()` returns the real directory name instead of "." / "..".
            let name_path = std::path::Path::new(&path);
            let name_path = match name_path.file_name() {
                Some(name) if name != "." && name != ".." => name_path,
                _ => &std::env::current_dir()
                    .expect("Failed to get current directory")
                    .join(&path),
            };
            let name = name_path
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

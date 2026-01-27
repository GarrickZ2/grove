mod app;
mod check;
mod cli;
mod event;
mod git;
mod hooks;
mod model;
mod storage;
mod theme;
mod tmux;
mod ui;
mod update;

use std::io::{self, Write};
use std::time::Instant;

use clap::Parser;
use ratatui::DefaultTerminal;

use app::{App, AppMode};
use cli::{Cli, Commands};

/// Auto-refresh interval in seconds
const AUTO_REFRESH_INTERVAL_SECS: u64 = 5;

fn main() -> io::Result<()> {
    // 解析命令行参数
    let cli = Cli::parse();

    // 如果有子命令，执行 CLI 逻辑
    if let Some(command) = cli.command {
        match command {
            Commands::Hooks { level } => {
                cli::hooks::execute(level);
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

    // 创建应用
    let mut app = App::new();

    // 运行主循环
    let result = run(&mut terminal, &mut app);

    // 恢复终端
    ratatui::restore();

    result
}

fn run(terminal: &mut DefaultTerminal, app: &mut App) -> io::Result<()> {
    let mut last_refresh = Instant::now();

    loop {
        // 检查是否有待 attach 的 session
        if let Some(session) = app.pending_tmux_attach.take() {
            // 暂停 TUI
            ratatui::restore();

            // attach 到 session（阻塞，直到用户 detach）
            let _ = tmux::attach_session(&session);

            // 清除 tmux detach 消息（只清除一行）
            // \x1b[1A - 光标上移一行
            // \x1b[2K - 清除当前行
            // \r     - 光标移到行首
            print!("\x1b[1A\x1b[2K\r");
            let _ = io::stdout().flush();

            // 清除该任务的 hook 通知（用户已阅）
            app.clear_task_hook_by_session(&session);

            // 恢复 TUI
            *terminal = ratatui::init();

            // 刷新数据（用户可能在 session 中做了改动）
            app.refresh();
            last_refresh = Instant::now();
        }

        // 定时自动刷新（每 5 秒）
        if last_refresh.elapsed().as_secs() >= AUTO_REFRESH_INTERVAL_SECS {
            app.refresh();
            last_refresh = Instant::now();
        }

        // 渲染界面
        terminal.draw(|frame| match app.mode {
            AppMode::Workspace => ui::workspace::render(frame, app),
            AppMode::Project => ui::project::render(frame, app),
        })?;

        // 处理事件
        if !event::handle_events(app)? {
            break;
        }
    }

    Ok(())
}

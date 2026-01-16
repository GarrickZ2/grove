mod app;
mod cli;
mod event;
mod git;
mod hooks;
mod model;
mod storage;
mod theme;
mod tmux;
mod ui;

use std::io;

use clap::Parser;
use ratatui::DefaultTerminal;

use app::{App, AppMode};
use cli::{Cli, Commands};

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
    loop {
        // 检查是否有待 attach 的 session
        if let Some(session) = app.pending_tmux_attach.take() {
            // 暂停 TUI
            ratatui::restore();

            // attach 到 session（阻塞，直到用户 detach）
            let _ = tmux::attach_session(&session);

            // 恢复 TUI
            *terminal = ratatui::init();

            // 刷新数据（用户可能在 session 中做了改动）
            app.project.refresh();
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

mod app;
mod event;
mod model;
mod theme;
mod ui;

use std::io;

use ratatui::DefaultTerminal;

use app::App;

fn main() -> io::Result<()> {
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
        // 渲染界面
        terminal.draw(|frame| {
            ui::project::render(frame, app);
        })?;

        // 处理事件
        if !event::handle_events(app)? {
            break;
        }
    }

    Ok(())
}

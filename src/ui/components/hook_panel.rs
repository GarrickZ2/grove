//! Hook 配置面板组件（3 步配置流程）

use ratatui::{
    layout::{Alignment, Constraint, Layout, Rect},
    style::{Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Clear, Paragraph},
    Frame,
};

use crate::theme::ThemeColors;

/// 配置步骤
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HookConfigStep {
    SelectLevel,
    SelectSound,
    SelectBanner,
    ShowResult,
}

/// Hook 级别
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HookLevel {
    Notice,
    Warn,
    Critical,
}

impl HookLevel {
    pub fn name(&self) -> &'static str {
        match self {
            HookLevel::Notice => "notice",
            HookLevel::Warn => "warn",
            HookLevel::Critical => "critical",
        }
    }

    pub fn description(&self) -> &'static str {
        match self {
            HookLevel::Notice => "Normal notification",
            HookLevel::Warn => "Warning notification",
            HookLevel::Critical => "Critical alert",
        }
    }

    pub fn all() -> &'static [HookLevel] {
        &[HookLevel::Notice, HookLevel::Warn, HookLevel::Critical]
    }
}

/// 声音选项
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SoundOption {
    None,
    Glass,
    Purr,
    Sosumi,
    Basso,
}

impl SoundOption {
    pub fn name(&self) -> &'static str {
        match self {
            SoundOption::None => "none",
            SoundOption::Glass => "Glass",
            SoundOption::Purr => "Purr",
            SoundOption::Sosumi => "Sosumi",
            SoundOption::Basso => "Basso",
        }
    }

    pub fn description(&self) -> &'static str {
        match self {
            SoundOption::None => "No sound",
            SoundOption::Glass => "Default for notice",
            SoundOption::Purr => "Default for warn",
            SoundOption::Sosumi => "Default for critical",
            SoundOption::Basso => "Deep tone",
        }
    }

    pub fn all() -> &'static [SoundOption] {
        &[
            SoundOption::None,
            SoundOption::Glass,
            SoundOption::Purr,
            SoundOption::Sosumi,
            SoundOption::Basso,
        ]
    }
}

/// Hook 配置面板数据
#[derive(Debug, Clone)]
pub struct HookConfigData {
    pub step: HookConfigStep,
    pub level: HookLevel,
    pub sound: SoundOption,
    pub banner: bool,
    pub selected_index: usize,
    pub generated_command: String,
}

impl HookConfigData {
    pub fn new() -> Self {
        Self {
            step: HookConfigStep::SelectLevel,
            level: HookLevel::Notice,
            sound: SoundOption::Glass,
            banner: false,
            selected_index: 0,
            generated_command: String::new(),
        }
    }

    /// 获取当前步骤的选项数量
    pub fn current_options_count(&self) -> usize {
        match self.step {
            HookConfigStep::SelectLevel => HookLevel::all().len(),
            HookConfigStep::SelectSound => SoundOption::all().len(),
            HookConfigStep::SelectBanner => 2,
            HookConfigStep::ShowResult => 0,
        }
    }

    /// 向上移动选择
    pub fn select_prev(&mut self) {
        let count = self.current_options_count();
        if count > 0 {
            if self.selected_index == 0 {
                self.selected_index = count - 1;
            } else {
                self.selected_index -= 1;
            }
        }
    }

    /// 向下移动选择
    pub fn select_next(&mut self) {
        let count = self.current_options_count();
        if count > 0 {
            if self.selected_index >= count - 1 {
                self.selected_index = 0;
            } else {
                self.selected_index += 1;
            }
        }
    }

    /// 确认当前选择，进入下一步
    pub fn confirm(&mut self) {
        match self.step {
            HookConfigStep::SelectLevel => {
                self.level = HookLevel::all()[self.selected_index];
                self.step = HookConfigStep::SelectSound;
                // 根据级别设置默认声音索引
                self.selected_index = match self.level {
                    HookLevel::Notice => 1,  // Glass
                    HookLevel::Warn => 2,    // Purr
                    HookLevel::Critical => 3, // Sosumi
                };
            }
            HookConfigStep::SelectSound => {
                self.sound = SoundOption::all()[self.selected_index];
                self.step = HookConfigStep::SelectBanner;
                // 根据级别设置默认 banner
                self.selected_index = match self.level {
                    HookLevel::Notice => 1,  // No
                    HookLevel::Warn | HookLevel::Critical => 0, // Yes
                };
            }
            HookConfigStep::SelectBanner => {
                self.banner = self.selected_index == 0; // 0 = Yes, 1 = No
                self.step = HookConfigStep::ShowResult;
                self.generated_command = self.generate_command();
            }
            HookConfigStep::ShowResult => {
                // 关闭面板（由调用方处理）
            }
        }
    }

    /// 返回上一步
    pub fn back(&mut self) {
        match self.step {
            HookConfigStep::SelectLevel => {
                // 已经是第一步，无法返回（取消）
            }
            HookConfigStep::SelectSound => {
                self.step = HookConfigStep::SelectLevel;
                self.selected_index = 0;
            }
            HookConfigStep::SelectBanner => {
                self.step = HookConfigStep::SelectSound;
                self.selected_index = 0;
            }
            HookConfigStep::ShowResult => {
                self.step = HookConfigStep::SelectBanner;
                self.selected_index = 0;
            }
        }
    }

    /// 生成最终命令
    pub fn generate_command(&self) -> String {
        let mut cmd = format!("grove hooks {}", self.level.name());

        cmd.push_str(&format!(" --sound {}", self.sound.name()));

        if self.banner {
            cmd.push_str(" --banner");
        } else {
            cmd.push_str(" --no-banner");
        }

        cmd
    }
}

/// 弹窗尺寸
const DIALOG_WIDTH: u16 = 45;
const DIALOG_HEIGHT: u16 = 14;

/// 渲染 Hook 配置面板
pub fn render(frame: &mut Frame, data: &HookConfigData, colors: &ThemeColors) {
    let area = frame.area();

    // 居中计算
    let x = area.width.saturating_sub(DIALOG_WIDTH) / 2;
    let y = area.height.saturating_sub(DIALOG_HEIGHT) / 2;
    let dialog_area = Rect::new(
        x,
        y,
        DIALOG_WIDTH.min(area.width),
        DIALOG_HEIGHT.min(area.height),
    );

    // 清除背景
    frame.render_widget(Clear, dialog_area);

    // 外框
    let block = Block::default()
        .title(" Hook Config ")
        .title_alignment(Alignment::Center)
        .title_style(Style::default().fg(colors.highlight).add_modifier(Modifier::BOLD))
        .borders(Borders::ALL)
        .border_style(Style::default().fg(colors.border))
        .style(Style::default().bg(colors.bg));

    let inner_area = block.inner(dialog_area);
    frame.render_widget(block, dialog_area);

    // 内部布局
    let [header_area, _spacer1, content_area, _spacer2, hint_area] = Layout::vertical([
        Constraint::Length(1), // 步骤指示
        Constraint::Length(1), // 间隔
        Constraint::Min(1),    // 内容
        Constraint::Length(1), // 间隔
        Constraint::Length(1), // 提示
    ])
    .areas(inner_area);

    match data.step {
        HookConfigStep::SelectLevel => {
            render_step_header(frame, header_area, "1/3", "Notification Level", colors);
            render_level_options(frame, content_area, data.selected_index, colors);
            render_hint(frame, hint_area, "↑↓ select   Enter next   Esc cancel", colors);
        }
        HookConfigStep::SelectSound => {
            render_step_header(frame, header_area, "2/3", "Sound", colors);
            render_sound_options(frame, content_area, data.selected_index, colors);
            render_hint(frame, hint_area, "↑↓ select   Enter next   Esc back", colors);
        }
        HookConfigStep::SelectBanner => {
            render_step_header(frame, header_area, "3/3", "System Notification", colors);
            render_banner_options(frame, content_area, data.selected_index, colors);
            render_hint(frame, hint_area, "↑↓ select   Enter done   Esc back", colors);
        }
        HookConfigStep::ShowResult => {
            render_result(frame, inner_area, &data.generated_command, colors);
        }
    }
}

fn render_step_header(frame: &mut Frame, area: Rect, step: &str, title: &str, colors: &ThemeColors) {
    let header = Paragraph::new(Line::from(vec![
        Span::styled(format!("  {}  ", step), Style::default().fg(colors.muted)),
        Span::styled(title, Style::default().fg(colors.text).add_modifier(Modifier::BOLD)),
    ]));
    frame.render_widget(header, area);
}

fn render_level_options(frame: &mut Frame, area: Rect, selected: usize, colors: &ThemeColors) {
    let mut lines: Vec<Line> = Vec::new();
    for (i, level) in HookLevel::all().iter().enumerate() {
        let is_selected = i == selected;
        let prefix = if is_selected { "  ❯ " } else { "    " };
        let name_style = if is_selected {
            Style::default().fg(colors.highlight).add_modifier(Modifier::BOLD)
        } else {
            Style::default().fg(colors.text)
        };
        lines.push(Line::from(vec![
            Span::styled(prefix, name_style),
            Span::styled(format!("{:<12}", level.name()), name_style),
            Span::styled(level.description(), Style::default().fg(colors.muted)),
        ]));
    }
    let list = Paragraph::new(lines);
    frame.render_widget(list, area);
}

fn render_sound_options(frame: &mut Frame, area: Rect, selected: usize, colors: &ThemeColors) {
    let mut lines: Vec<Line> = Vec::new();
    for (i, sound) in SoundOption::all().iter().enumerate() {
        let is_selected = i == selected;
        let prefix = if is_selected { "  ❯ " } else { "    " };
        let name_style = if is_selected {
            Style::default().fg(colors.highlight).add_modifier(Modifier::BOLD)
        } else {
            Style::default().fg(colors.text)
        };
        lines.push(Line::from(vec![
            Span::styled(prefix, name_style),
            Span::styled(format!("{:<12}", sound.name()), name_style),
            Span::styled(sound.description(), Style::default().fg(colors.muted)),
        ]));
    }
    let list = Paragraph::new(lines);
    frame.render_widget(list, area);
}

fn render_banner_options(frame: &mut Frame, area: Rect, selected: usize, colors: &ThemeColors) {
    let options = [
        ("yes", "Show macOS banner"),
        ("no", "No system notification"),
    ];

    let mut lines: Vec<Line> = Vec::new();
    for (i, (name, desc)) in options.iter().enumerate() {
        let is_selected = i == selected;
        let prefix = if is_selected { "  ❯ " } else { "    " };
        let name_style = if is_selected {
            Style::default().fg(colors.highlight).add_modifier(Modifier::BOLD)
        } else {
            Style::default().fg(colors.text)
        };
        lines.push(Line::from(vec![
            Span::styled(prefix, name_style),
            Span::styled(format!("{:<12}", name), name_style),
            Span::styled(*desc, Style::default().fg(colors.muted)),
        ]));
    }
    let list = Paragraph::new(lines);
    frame.render_widget(list, area);
}

fn render_result(frame: &mut Frame, area: Rect, command: &str, colors: &ThemeColors) {
    let [_spacer1, title_area, _spacer2, desc_area, _spacer3, cmd_area, _spacer4, hint_area] =
        Layout::vertical([
            Constraint::Length(1),
            Constraint::Length(1),
            Constraint::Length(1),
            Constraint::Length(1),
            Constraint::Length(1),
            Constraint::Length(3),  // 边框 2 行 + 内容 1 行
            Constraint::Min(1),
            Constraint::Length(1),
        ])
        .areas(area);

    // 标题
    let title = Paragraph::new(Line::from(vec![
        Span::styled("  ✓ ", Style::default().fg(colors.status_live)),
        Span::styled("Copied to clipboard!", Style::default().fg(colors.text).add_modifier(Modifier::BOLD)),
    ]));
    frame.render_widget(title, title_area);

    // 描述
    let desc = Paragraph::new(Line::from(Span::styled(
        "  Paste to your agent's hook config:",
        Style::default().fg(colors.muted),
    )));
    frame.render_widget(desc, desc_area);

    // 命令（带边框）
    let cmd_block = Paragraph::new(Line::from(Span::styled(
        format!("  {} ", command),
        Style::default().fg(colors.highlight),
    )))
    .block(
        Block::default()
            .borders(Borders::ALL)
            .border_style(Style::default().fg(colors.border)),
    );
    frame.render_widget(cmd_block, cmd_area);

    // 提示
    render_hint(frame, hint_area, "Enter close   c copy", colors);
}

fn render_hint(frame: &mut Frame, area: Rect, hint_text: &str, colors: &ThemeColors) {
    // 解析 hint_text，高亮快捷键
    let mut spans: Vec<Span> = Vec::new();
    let parts: Vec<&str> = hint_text.split_whitespace().collect();
    for (i, part) in parts.iter().enumerate() {
        if i > 0 {
            spans.push(Span::raw(" "));
        }
        // 快捷键（单个字符或特殊键）高亮
        if *part == "↑↓" || *part == "Enter" || *part == "Esc" || part.len() == 1 {
            spans.push(Span::styled(*part, Style::default().fg(colors.highlight)));
        } else {
            spans.push(Span::styled(*part, Style::default().fg(colors.muted)));
        }
    }

    let hint = Paragraph::new(Line::from(spans)).alignment(Alignment::Center);
    frame.render_widget(hint, area);
}

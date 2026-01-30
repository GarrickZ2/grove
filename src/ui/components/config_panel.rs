//! Config 配置面板组件（包含 Coding Agent / Task Layout / Hook Config 子页面）

use ratatui::{
    layout::{Alignment, Constraint, Layout, Rect},
    style::{Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Clear, Paragraph},
    Frame,
};

use crate::storage::config::LayoutConfig;
use crate::theme::ThemeColors;
use crate::tmux::layout::TaskLayout;
use crate::ui::click_areas::{ClickAreas, DialogAction};

use super::hook_panel::HookConfigData;

/// 预设文档名
pub const PRESET_DOCS: [&str; 3] = ["CLAUDE.md", "AGENTS.md", "GEMINI.md"];

/// 配置面板步骤
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ConfigStep {
    /// 主菜单 (0=Coding Agent, 1=Task Layout, 2=Hook Config)
    Main,
    /// Coding Agent 子菜单 (0=Command, 1=Context Docs)
    AgentMenu,
    /// 编辑 agent 命令（文本输入）
    EditAgentCommand,
    /// 选择布局预设
    SelectLayout,
    /// 选择 Context Docs（多选）
    SelectContextDocs,
    /// Hook 配置向导（复用现有逻辑）
    HookWizard,
}

/// Config 面板数据
#[derive(Debug, Clone)]
pub struct ConfigPanelData {
    pub step: ConfigStep,
    /// 主菜单选中项 (0=Coding Agent, 1=Task Layout, 2=Hook Config)
    pub main_selected: usize,
    /// Agent 子菜单选中项 (0=Command, 1=Context Docs)
    pub agent_menu_selected: usize,
    /// 布局选中项
    pub layout_selected: usize,
    /// agent 命令输入缓冲
    pub agent_input: String,
    /// agent 命令光标位置
    pub agent_cursor: usize,
    /// Hook 配置数据（子页面）
    pub hook_data: HookConfigData,
    /// Context docs: 三个预设的选中状态
    pub context_docs_selected: [bool; 3],
    /// Context docs: custom 是否启用
    pub context_docs_custom_enabled: bool,
    /// Context docs: custom 文件名
    pub context_docs_custom_name: String,
    /// Context docs: 列表光标 (0-3)
    pub context_docs_cursor: usize,
    /// Context docs: 是否正在编辑 custom 名称
    pub context_docs_editing_custom: bool,
}

impl ConfigPanelData {
    pub fn new(config: &LayoutConfig) -> Self {
        // 从 config 加载当前布局选中索引
        let layout_selected = TaskLayout::all()
            .iter()
            .position(|l| l.name() == config.default)
            .unwrap_or(0);

        let agent_input = config.agent_command.clone().unwrap_or_default();

        // 解析 context_docs
        let mut selected = [false; 3];
        let mut custom_name = String::new();
        let mut custom_enabled = false;

        for doc in &config.context_docs {
            if let Some(idx) = PRESET_DOCS.iter().position(|&p| p == doc) {
                selected[idx] = true;
            } else {
                custom_name = doc.clone();
                custom_enabled = true;
            }
        }

        Self {
            step: ConfigStep::Main,
            main_selected: 0,
            agent_menu_selected: 0,
            layout_selected,
            agent_input: agent_input.clone(),
            agent_cursor: agent_input.len(),
            hook_data: HookConfigData::new(),
            context_docs_selected: selected,
            context_docs_custom_enabled: custom_enabled,
            context_docs_custom_name: custom_name,
            context_docs_cursor: 0,
            context_docs_editing_custom: false,
        }
    }

    /// 统计 context docs 选中数量
    pub fn context_docs_count(&self) -> usize {
        let preset_count = self.context_docs_selected.iter().filter(|&&v| v).count();
        let custom_count =
            if self.context_docs_custom_enabled && !self.context_docs_custom_name.is_empty() {
                1
            } else {
                0
            };
        preset_count + custom_count
    }
}

/// 弹窗尺寸
const DIALOG_WIDTH: u16 = 50;
const DIALOG_HEIGHT_MAIN: u16 = 10;
const DIALOG_HEIGHT_AGENT_MENU: u16 = 10;
const DIALOG_HEIGHT_AGENT_CMD: u16 = 11;
const DIALOG_HEIGHT_LAYOUT: u16 = 13;
const DIALOG_HEIGHT_CONTEXT: u16 = 14;

/// 渲染 Config 面板
pub fn render(
    frame: &mut Frame,
    data: &ConfigPanelData,
    config: &LayoutConfig,
    colors: &ThemeColors,
    click_areas: &mut ClickAreas,
) {
    match &data.step {
        ConfigStep::Main => render_main(frame, data, config, colors, click_areas),
        ConfigStep::AgentMenu => render_agent_menu(frame, data, config, colors, click_areas),
        ConfigStep::EditAgentCommand => render_agent_editor(frame, data, colors, click_areas),
        ConfigStep::SelectLayout => render_layout_selector(frame, data, colors, click_areas),
        ConfigStep::SelectContextDocs => render_context_docs(frame, data, colors, click_areas),
        ConfigStep::HookWizard => {
            super::hook_panel::render(frame, &data.hook_data, colors, click_areas);
        }
    }
}

/// 渲染主菜单
fn render_main(
    frame: &mut Frame,
    data: &ConfigPanelData,
    config: &LayoutConfig,
    colors: &ThemeColors,
    click_areas: &mut ClickAreas,
) {
    let area = frame.area();
    let height = DIALOG_HEIGHT_MAIN;

    let x = area.width.saturating_sub(DIALOG_WIDTH) / 2;
    let y = area.height.saturating_sub(height) / 2;
    let dialog_area = Rect::new(x, y, DIALOG_WIDTH.min(area.width), height.min(area.height));

    frame.render_widget(Clear, dialog_area);

    let block = Block::default()
        .title(" Config ")
        .title_alignment(Alignment::Center)
        .title_style(
            Style::default()
                .fg(colors.highlight)
                .add_modifier(Modifier::BOLD),
        )
        .borders(Borders::ALL)
        .border_style(Style::default().fg(colors.border))
        .style(Style::default().bg(colors.bg));

    let inner_area = block.inner(dialog_area);
    frame.render_widget(block, dialog_area);

    let [_spacer1, content_area, _spacer2, hint_area] = Layout::vertical([
        Constraint::Length(1),
        Constraint::Min(1),
        Constraint::Length(1),
        Constraint::Length(1),
    ])
    .areas(inner_area);

    // 菜单项（3 项）
    let agent_value = config
        .agent_command
        .as_deref()
        .filter(|s| !s.is_empty())
        .unwrap_or("(not set)");
    let layout_value = TaskLayout::from_name(&config.default)
        .map(|l| l.label())
        .unwrap_or("single");

    let items: Vec<(&str, &str)> = vec![
        ("Coding Agent", agent_value),
        ("Task Layout", layout_value),
        ("Hook Config", ""),
    ];

    let mut lines: Vec<Line> = Vec::new();
    for (i, (label, value)) in items.iter().enumerate() {
        let is_selected = i == data.main_selected;
        let prefix = if is_selected { "  \u{276f} " } else { "    " };
        let name_style = if is_selected {
            Style::default()
                .fg(colors.highlight)
                .add_modifier(Modifier::BOLD)
        } else {
            Style::default().fg(colors.text)
        };

        let mut spans = vec![
            Span::styled(prefix, name_style),
            Span::styled(format!("{:<16}", label), name_style),
        ];
        if !value.is_empty() {
            spans.push(Span::styled(*value, Style::default().fg(colors.muted)));
        }
        lines.push(Line::from(spans));
    }

    let list = Paragraph::new(lines);
    frame.render_widget(list, content_area);

    render_hint(
        frame,
        hint_area,
        "\u{2191}\u{2193} select   Enter open   Esc close",
        colors,
    );

    // 注册点击区域
    click_areas.dialog_area = Some(dialog_area);
    for i in 0..items.len() {
        let row_rect = Rect::new(
            content_area.x,
            content_area.y + i as u16,
            content_area.width,
            1,
        );
        click_areas.dialog_items.push((row_rect, i));
    }
    let half = hint_area.width / 2;
    click_areas.dialog_buttons.push((
        Rect::new(hint_area.x, hint_area.y, half, 1),
        DialogAction::Confirm,
    ));
    click_areas.dialog_buttons.push((
        Rect::new(hint_area.x + half, hint_area.y, hint_area.width - half, 1),
        DialogAction::Cancel,
    ));
}

/// 渲染 Coding Agent 子菜单
fn render_agent_menu(
    frame: &mut Frame,
    data: &ConfigPanelData,
    config: &LayoutConfig,
    colors: &ThemeColors,
    click_areas: &mut ClickAreas,
) {
    let area = frame.area();
    let height = DIALOG_HEIGHT_AGENT_MENU;

    let x = area.width.saturating_sub(DIALOG_WIDTH) / 2;
    let y = area.height.saturating_sub(height) / 2;
    let dialog_area = Rect::new(x, y, DIALOG_WIDTH.min(area.width), height.min(area.height));

    frame.render_widget(Clear, dialog_area);

    let block = Block::default()
        .title(" Coding Agent ")
        .title_alignment(Alignment::Center)
        .title_style(
            Style::default()
                .fg(colors.highlight)
                .add_modifier(Modifier::BOLD),
        )
        .borders(Borders::ALL)
        .border_style(Style::default().fg(colors.border))
        .style(Style::default().bg(colors.bg));

    let inner_area = block.inner(dialog_area);
    frame.render_widget(block, dialog_area);

    let [_spacer1, content_area, _spacer2, hint_area] = Layout::vertical([
        Constraint::Length(1),
        Constraint::Min(1),
        Constraint::Length(1),
        Constraint::Length(1),
    ])
    .areas(inner_area);

    let cmd_value = config
        .agent_command
        .as_deref()
        .filter(|s| !s.is_empty())
        .unwrap_or("(not set)");
    let docs_value = format!("{} docs", data.context_docs_count());

    let items: Vec<(&str, String)> = vec![
        ("Command", cmd_value.to_string()),
        ("Context Docs", docs_value),
    ];

    let mut lines: Vec<Line> = Vec::new();
    for (i, (label, value)) in items.iter().enumerate() {
        let is_selected = i == data.agent_menu_selected;
        let prefix = if is_selected { "  \u{276f} " } else { "    " };
        let name_style = if is_selected {
            Style::default()
                .fg(colors.highlight)
                .add_modifier(Modifier::BOLD)
        } else {
            Style::default().fg(colors.text)
        };

        let mut spans = vec![
            Span::styled(prefix, name_style),
            Span::styled(format!("{:<16}", label), name_style),
        ];
        if !value.is_empty() {
            spans.push(Span::styled(value.as_str(), Style::default().fg(colors.muted)));
        }
        lines.push(Line::from(spans));
    }

    let list = Paragraph::new(lines);
    frame.render_widget(list, content_area);

    render_hint(
        frame,
        hint_area,
        "\u{2191}\u{2193} select   Enter open   Esc back",
        colors,
    );

    // 注册点击区域
    click_areas.dialog_area = Some(dialog_area);
    for i in 0..items.len() {
        let row_rect = Rect::new(
            content_area.x,
            content_area.y + i as u16,
            content_area.width,
            1,
        );
        click_areas.dialog_items.push((row_rect, i));
    }
    let half = hint_area.width / 2;
    click_areas.dialog_buttons.push((
        Rect::new(hint_area.x, hint_area.y, half, 1),
        DialogAction::Confirm,
    ));
    click_areas.dialog_buttons.push((
        Rect::new(hint_area.x + half, hint_area.y, hint_area.width - half, 1),
        DialogAction::Cancel,
    ));
}

/// 渲染 Coding Agent 命令编辑页
fn render_agent_editor(
    frame: &mut Frame,
    data: &ConfigPanelData,
    colors: &ThemeColors,
    click_areas: &mut ClickAreas,
) {
    let area = frame.area();
    let height = DIALOG_HEIGHT_AGENT_CMD;

    let x = area.width.saturating_sub(DIALOG_WIDTH) / 2;
    let y = area.height.saturating_sub(height) / 2;
    let dialog_area = Rect::new(x, y, DIALOG_WIDTH.min(area.width), height.min(area.height));

    frame.render_widget(Clear, dialog_area);

    let block = Block::default()
        .title(" Agent Command ")
        .title_alignment(Alignment::Center)
        .title_style(
            Style::default()
                .fg(colors.highlight)
                .add_modifier(Modifier::BOLD),
        )
        .borders(Borders::ALL)
        .border_style(Style::default().fg(colors.border))
        .style(Style::default().bg(colors.bg));

    let inner_area = block.inner(dialog_area);
    frame.render_widget(block, dialog_area);

    let [_spacer1, label_area, _spacer2, input_area, _spacer3, hint_area] = Layout::vertical([
        Constraint::Length(1),
        Constraint::Length(1),
        Constraint::Length(1),
        Constraint::Length(3),
        Constraint::Min(1),
        Constraint::Length(1),
    ])
    .areas(inner_area);

    let label = Paragraph::new(Line::from(Span::styled(
        "  Command to launch coding agent:",
        Style::default().fg(colors.text),
    )));
    frame.render_widget(label, label_area);

    let display_text = if data.agent_input.is_empty() {
        "\u{2588}".to_string()
    } else {
        format!("{}\u{2588}", data.agent_input)
    };

    let input = Paragraph::new(Line::from(Span::styled(
        format!(" {} ", display_text),
        Style::default().fg(colors.highlight),
    )))
    .block(
        Block::default()
            .borders(Borders::ALL)
            .border_style(Style::default().fg(colors.border)),
    );
    frame.render_widget(input, input_area);

    render_hint(frame, hint_area, "Enter save   Esc back", colors);

    // 注册点击区域
    click_areas.dialog_area = Some(dialog_area);
    let half = hint_area.width / 2;
    click_areas.dialog_buttons.push((
        Rect::new(hint_area.x, hint_area.y, half, 1),
        DialogAction::Confirm,
    ));
    click_areas.dialog_buttons.push((
        Rect::new(hint_area.x + half, hint_area.y, hint_area.width - half, 1),
        DialogAction::Cancel,
    ));
}

/// 渲染 Task Layout 选择页
fn render_layout_selector(
    frame: &mut Frame,
    data: &ConfigPanelData,
    colors: &ThemeColors,
    click_areas: &mut ClickAreas,
) {
    let area = frame.area();
    let height = DIALOG_HEIGHT_LAYOUT;

    let x = area.width.saturating_sub(DIALOG_WIDTH) / 2;
    let y = area.height.saturating_sub(height) / 2;
    let dialog_area = Rect::new(x, y, DIALOG_WIDTH.min(area.width), height.min(area.height));

    frame.render_widget(Clear, dialog_area);

    let block = Block::default()
        .title(" Task Layout ")
        .title_alignment(Alignment::Center)
        .title_style(
            Style::default()
                .fg(colors.highlight)
                .add_modifier(Modifier::BOLD),
        )
        .borders(Borders::ALL)
        .border_style(Style::default().fg(colors.border))
        .style(Style::default().bg(colors.bg));

    let inner_area = block.inner(dialog_area);
    frame.render_widget(block, dialog_area);

    let [_spacer1, content_area, _spacer2, hint_area] = Layout::vertical([
        Constraint::Length(1),
        Constraint::Min(1),
        Constraint::Length(1),
        Constraint::Length(1),
    ])
    .areas(inner_area);

    let layouts = TaskLayout::all();
    let descriptions: &[&str] = &[
        "Default shell only",
        "Auto-start agent",
        "Agent (60%) + Shell (40%)",
        "Agent + Grove + Shell",
        "Grove (40%) + Agent (60%)",
    ];

    let mut lines: Vec<Line> = Vec::new();
    for (i, layout) in layouts.iter().enumerate() {
        let is_selected = i == data.layout_selected;
        let prefix = if is_selected { "  \u{276f} " } else { "    " };
        let name_style = if is_selected {
            Style::default()
                .fg(colors.highlight)
                .add_modifier(Modifier::BOLD)
        } else {
            Style::default().fg(colors.text)
        };

        let desc = descriptions.get(i).unwrap_or(&"");
        lines.push(Line::from(vec![
            Span::styled(prefix, name_style),
            Span::styled(format!("{:<18}", layout.label()), name_style),
            Span::styled(*desc, Style::default().fg(colors.muted)),
        ]));
    }

    let list = Paragraph::new(lines);
    frame.render_widget(list, content_area);

    render_hint(
        frame,
        hint_area,
        "\u{2191}\u{2193} select   Enter save   Esc back",
        colors,
    );

    // 注册点击区域
    click_areas.dialog_area = Some(dialog_area);
    for i in 0..layouts.len() {
        let row_rect = Rect::new(
            content_area.x,
            content_area.y + i as u16,
            content_area.width,
            1,
        );
        click_areas.dialog_items.push((row_rect, i));
    }
    let half = hint_area.width / 2;
    click_areas.dialog_buttons.push((
        Rect::new(hint_area.x, hint_area.y, half, 1),
        DialogAction::Confirm,
    ));
    click_areas.dialog_buttons.push((
        Rect::new(hint_area.x + half, hint_area.y, hint_area.width - half, 1),
        DialogAction::Cancel,
    ));
}

/// 渲染 Context Docs 多选页
fn render_context_docs(
    frame: &mut Frame,
    data: &ConfigPanelData,
    colors: &ThemeColors,
    click_areas: &mut ClickAreas,
) {
    let area = frame.area();
    let height = DIALOG_HEIGHT_CONTEXT;

    let x = area.width.saturating_sub(DIALOG_WIDTH) / 2;
    let y = area.height.saturating_sub(height) / 2;
    let dialog_area = Rect::new(x, y, DIALOG_WIDTH.min(area.width), height.min(area.height));

    frame.render_widget(Clear, dialog_area);

    let block = Block::default()
        .title(" Context Docs ")
        .title_alignment(Alignment::Center)
        .title_style(
            Style::default()
                .fg(colors.highlight)
                .add_modifier(Modifier::BOLD),
        )
        .borders(Borders::ALL)
        .border_style(Style::default().fg(colors.border))
        .style(Style::default().bg(colors.bg));

    let inner_area = block.inner(dialog_area);
    frame.render_widget(block, dialog_area);

    let [_spacer1, label_area, _spacer2, content_area, _spacer3, hint_area] = Layout::vertical([
        Constraint::Length(1),
        Constraint::Length(1),
        Constraint::Length(1),
        Constraint::Min(1),
        Constraint::Length(1),
        Constraint::Length(1),
    ])
    .areas(inner_area);

    frame.render_widget(
        Paragraph::new(Line::from(Span::styled(
            "  Select files to inject into:",
            Style::default().fg(colors.text),
        ))),
        label_area,
    );

    let mut lines: Vec<Line> = Vec::new();

    for (i, preset_name) in PRESET_DOCS.iter().enumerate() {
        let checked = data.context_docs_selected[i];
        let is_cursor = i == data.context_docs_cursor;
        let checkbox = if checked { "[x]" } else { "[ ]" };

        let row_style = if is_cursor {
            Style::default()
                .fg(colors.highlight)
                .add_modifier(Modifier::BOLD)
        } else {
            Style::default().fg(colors.text)
        };

        let prefix = if is_cursor { "  \u{276f} " } else { "    " };
        lines.push(Line::from(vec![
            Span::styled(prefix, row_style),
            Span::styled(format!("{} ", checkbox), row_style),
            Span::styled(*preset_name, row_style),
        ]));
    }

    // Custom 行
    let custom_idx = 3;
    let is_cursor = data.context_docs_cursor == custom_idx;
    let prefix = if is_cursor { "  \u{276f} " } else { "    " };
    let row_style = if is_cursor {
        Style::default()
            .fg(colors.highlight)
            .add_modifier(Modifier::BOLD)
    } else {
        Style::default().fg(colors.text)
    };

    if data.context_docs_editing_custom {
        let checkbox = "[x]";
        let display = if data.context_docs_custom_name.is_empty() {
            "\u{2588}".to_string()
        } else {
            format!("{}\u{2588}", data.context_docs_custom_name)
        };
        lines.push(Line::from(vec![
            Span::styled(prefix, row_style),
            Span::styled(format!("{} ", checkbox), row_style),
            Span::styled("Custom: ", row_style),
            Span::styled(display, Style::default().fg(colors.highlight)),
        ]));
    } else if data.context_docs_custom_enabled && !data.context_docs_custom_name.is_empty() {
        lines.push(Line::from(vec![
            Span::styled(prefix, row_style),
            Span::styled("[x] ", row_style),
            Span::styled(
                format!("Custom: {}", data.context_docs_custom_name),
                row_style,
            ),
        ]));
    } else {
        lines.push(Line::from(vec![
            Span::styled(prefix, row_style),
            Span::styled("[ ] ", row_style),
            Span::styled("Custom...", Style::default().fg(colors.muted)),
        ]));
    }

    frame.render_widget(Paragraph::new(lines), content_area);

    let hint_text = if data.context_docs_editing_custom {
        "Enter confirm   Esc cancel"
    } else {
        "\u{2191}\u{2193} select   Space toggle   Enter save   Esc back"
    };
    render_hint(frame, hint_area, hint_text, colors);

    // 注册点击区域
    click_areas.dialog_area = Some(dialog_area);
    // 4 行可选项（3 预设 + 1 custom）
    for i in 0..4usize {
        let row_rect = Rect::new(
            content_area.x,
            content_area.y + i as u16,
            content_area.width,
            1,
        );
        click_areas.dialog_items.push((row_rect, i));
    }
    let half = hint_area.width / 2;
    click_areas.dialog_buttons.push((
        Rect::new(hint_area.x, hint_area.y, half, 1),
        DialogAction::Confirm,
    ));
    click_areas.dialog_buttons.push((
        Rect::new(hint_area.x + half, hint_area.y, hint_area.width - half, 1),
        DialogAction::Cancel,
    ));
}

fn render_hint(frame: &mut Frame, area: Rect, hint_text: &str, colors: &ThemeColors) {
    let mut spans: Vec<Span> = Vec::new();
    let parts: Vec<&str> = hint_text.split_whitespace().collect();
    for (i, part) in parts.iter().enumerate() {
        if i > 0 {
            spans.push(Span::raw(" "));
        }
        if *part == "\u{2191}\u{2193}"
            || *part == "Enter"
            || *part == "Esc"
            || *part == "Space"
            || part.len() == 1
        {
            spans.push(Span::styled(*part, Style::default().fg(colors.highlight)));
        } else {
            spans.push(Span::styled(*part, Style::default().fg(colors.muted)));
        }
    }

    let hint = Paragraph::new(Line::from(spans)).alignment(Alignment::Center);
    frame.render_widget(hint, area);
}

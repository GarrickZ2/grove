//! Config 配置面板组件（包含 Coding Agent / Task Layout / Hook Config 子页面）

use ratatui::{
    layout::{Alignment, Constraint, Layout, Rect},
    style::{Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Clear, Paragraph},
    Frame,
};

use crate::storage::config::{AutoLinkConfig, LayoutConfig, TerminalMultiplexer};
use crate::theme::ThemeColors;
use crate::tmux::layout::{LayoutNode, PathSegment, SplitDirection, TaskLayout};
use crate::ui::click_areas::{ClickAreas, DialogAction};

use super::hook_panel::HookConfigData;

/// 配置面板步骤
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ConfigStep {
    /// 主菜单 (0=Coding Agent, 1=Task Layout, 2=Multiplexer, 3=AutoLink, 4=Hook Config, 5=MCP Config)
    Main,
    /// 编辑 agent 命令（文本输入）
    EditAgentCommand,
    /// 选择布局预设
    SelectLayout,
    /// 选择 Multiplexer (tmux / zellij)
    SelectMultiplexer,
    /// AutoLink 配置页面（管理 glob patterns）
    AutoLinkConfig,
    /// AutoLink 编辑/添加模式（文本输入）
    AutoLinkEdit,
    /// Hook 配置向导（复用现有逻辑）
    HookWizard,
    /// MCP 配置页面
    McpConfig,
    /// Custom Layout: 递归选择节点类型
    CustomChoose,
    /// Custom Layout: 输入自定义命令
    CustomPaneCommand,
}

/// Config 面板数据
#[derive(Debug, Clone)]
pub struct ConfigPanelData {
    pub step: ConfigStep,
    /// 主菜单选中项 (0=Coding Agent, 1=Task Layout, 2=Multiplexer, 3=AutoLink, 4=Hook Config, 5=MCP Config)
    pub main_selected: usize,
    /// Multiplexer 选中项 (0=tmux, 1=zellij)
    pub multiplexer_selected: usize,
    /// 布局选中项
    pub layout_selected: usize,
    /// agent 命令输入缓冲
    pub agent_input: String,
    /// agent 命令光标位置
    pub agent_cursor: usize,
    /// Hook 配置数据（子页面）
    pub hook_data: HookConfigData,
    /// AutoLink patterns (glob patterns list)
    pub autolink_patterns: Vec<String>,
    /// AutoLink patterns selected index
    pub autolink_selected: usize,
    /// AutoLink pattern input buffer (for adding/editing)
    pub autolink_input: String,
    /// AutoLink input cursor position
    pub autolink_cursor: usize,
    /// AutoLink: editing existing pattern (Some(index)) or adding new (None)
    pub autolink_editing: Option<usize>,
    /// Custom layout: 当前在树中的路径
    pub custom_build_path: Vec<PathSegment>,
    /// Custom layout: 正在构建的树
    pub custom_build_root: Option<LayoutNode>,
    /// Custom layout: 选择列表光标 (0=SplitH, 1=SplitV, 2=Agent, 3=Grove, 4=Shell, 5=FilePicker, 6=Custom)
    pub custom_choose_selected: usize,
    /// Custom layout: 自定义命令输入
    pub custom_cmd_input: String,
    /// Custom layout: 自定义命令光标
    pub custom_cmd_cursor: usize,
}

impl ConfigPanelData {
    pub fn with_multiplexer(
        config: &LayoutConfig,
        mux: &TerminalMultiplexer,
        autolink: &AutoLinkConfig,
    ) -> Self {
        // 从 config 加载当前布局选中索引
        let layout_selected = TaskLayout::all()
            .iter()
            .position(|l| l.name() == config.default)
            .unwrap_or(0);

        let agent_input = config.agent_command.clone().unwrap_or_default();

        // If layout is "custom", select index 5 (the Custom... option)
        let layout_selected = if config.default == "custom" {
            TaskLayout::all().len() // index after all presets
        } else {
            layout_selected
        };

        let multiplexer_selected = match mux {
            TerminalMultiplexer::Tmux => 0,
            TerminalMultiplexer::Zellij => 1,
        };

        Self {
            step: ConfigStep::Main,
            main_selected: 0,
            multiplexer_selected,
            layout_selected,
            agent_input: agent_input.clone(),
            agent_cursor: agent_input.len(),
            hook_data: HookConfigData::new(),
            autolink_patterns: autolink.patterns.clone(),
            autolink_selected: 0,
            autolink_input: String::new(),
            autolink_cursor: 0,
            autolink_editing: None,
            custom_build_path: Vec::new(),
            custom_build_root: None,
            custom_choose_selected: 3, // default to Agent
            custom_cmd_input: String::new(),
            custom_cmd_cursor: 0,
        }
    }
}

/// 弹窗尺寸
const DIALOG_WIDTH: u16 = 50;
const DIALOG_HEIGHT_MAIN: u16 = 12;
const DIALOG_HEIGHT_AGENT_CMD: u16 = 11;
const DIALOG_HEIGHT_LAYOUT: u16 = 15;
const DIALOG_HEIGHT_MCP: u16 = 15;

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
        ConfigStep::EditAgentCommand => render_agent_editor(frame, data, colors, click_areas),
        ConfigStep::SelectLayout => render_layout_selector(frame, data, colors, click_areas),
        ConfigStep::SelectMultiplexer => {
            render_multiplexer_selector(frame, data, colors, click_areas)
        }
        ConfigStep::AutoLinkConfig => render_autolink_config(frame, data, colors, click_areas),
        ConfigStep::AutoLinkEdit => render_autolink_editor(frame, data, colors, click_areas),
        ConfigStep::HookWizard => {
            super::hook_panel::render(frame, &data.hook_data, colors, click_areas);
        }
        ConfigStep::McpConfig => render_mcp_info(frame, colors, click_areas),
        ConfigStep::CustomChoose => render_custom_choose(frame, data, colors, click_areas),
        ConfigStep::CustomPaneCommand => {
            render_custom_pane_command(frame, data, colors, click_areas)
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

    // 菜单项（6 项）
    let agent_value = config
        .agent_command
        .as_deref()
        .filter(|s| !s.is_empty())
        .unwrap_or("(not set)");
    let layout_value = TaskLayout::from_name(&config.default)
        .map(|l| l.label())
        .unwrap_or("Single");
    let mux_value = if data.multiplexer_selected == 1 {
        "zellij"
    } else {
        "tmux"
    };
    let autolink_value = if data.autolink_patterns.is_empty() {
        "(not set)"
    } else {
        &format!("{} patterns", data.autolink_patterns.len())
    };

    let items: Vec<(&str, &str)> = vec![
        ("Coding Agent", agent_value),
        ("Task Layout", layout_value),
        ("Multiplexer", mux_value),
        ("AutoLink", autolink_value),
        ("Hook Config", ""),
        ("MCP Server", ""),
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

    let total_items = layouts.len() + 2; // +1 separator + 1 custom

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

    // Separator line
    lines.push(Line::from(Span::styled(
        "    ─────────────────────────────────────────",
        Style::default().fg(colors.border),
    )));

    // Custom... option (index = layouts.len(), visual row = layouts.len() + 1)
    let custom_idx = layouts.len();
    let is_custom_selected = data.layout_selected == custom_idx;
    let prefix = if is_custom_selected {
        "  \u{276f} "
    } else {
        "    "
    };
    let name_style = if is_custom_selected {
        Style::default()
            .fg(colors.highlight)
            .add_modifier(Modifier::BOLD)
    } else {
        Style::default().fg(colors.text)
    };
    lines.push(Line::from(vec![
        Span::styled(prefix, name_style),
        Span::styled(format!("{:<18}", "Custom..."), name_style),
        Span::styled("Build your own layout", Style::default().fg(colors.muted)),
    ]));

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
    for i in 0..total_items {
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

/// 渲染 Multiplexer 选择页
fn render_multiplexer_selector(
    frame: &mut Frame,
    data: &ConfigPanelData,
    colors: &ThemeColors,
    click_areas: &mut ClickAreas,
) {
    let area = frame.area();
    let height: u16 = 11;

    let x = area.width.saturating_sub(DIALOG_WIDTH) / 2;
    let y = area.height.saturating_sub(height) / 2;
    let dialog_area = Rect::new(x, y, DIALOG_WIDTH.min(area.width), height.min(area.height));

    frame.render_widget(Clear, dialog_area);

    let block = Block::default()
        .title(" Multiplexer ")
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
        Constraint::Length(3),
        Constraint::Min(1),
        Constraint::Length(1),
    ])
    .areas(inner_area);

    frame.render_widget(
        Paragraph::new(Line::from(Span::styled(
            "  Select terminal multiplexer:",
            Style::default().fg(colors.text),
        ))),
        label_area,
    );

    let tmux_installed = crate::check::check_tmux_available();
    let zellij_installed = crate::check::check_zellij_available();

    let items: [(&str, bool); 2] = [("tmux", tmux_installed), ("zellij", zellij_installed)];

    let mut lines: Vec<Line> = Vec::new();
    for (i, (label, installed)) in items.iter().enumerate() {
        let is_selected = i == data.multiplexer_selected;
        let prefix = if is_selected { "  \u{276f} " } else { "    " };

        let status = if *installed {
            "\u{2713} installed"
        } else {
            "\u{2717} not installed"
        };

        let style = if !installed {
            Style::default().fg(colors.muted)
        } else if is_selected {
            Style::default()
                .fg(colors.highlight)
                .add_modifier(Modifier::BOLD)
        } else {
            Style::default().fg(colors.text)
        };

        let status_style = if *installed {
            Style::default().fg(colors.highlight)
        } else {
            Style::default().fg(colors.muted)
        };

        lines.push(Line::from(vec![
            Span::styled(prefix, style),
            Span::styled(format!("{:<16}", label), style),
            Span::styled(status, status_style),
        ]));
    }

    frame.render_widget(Paragraph::new(lines), content_area);

    render_hint(
        frame,
        hint_area,
        "\u{2191}\u{2193} select   Enter save   Esc back",
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

/// 渲染 AutoLink 配置页面
fn render_autolink_config(
    frame: &mut Frame,
    data: &ConfigPanelData,
    colors: &ThemeColors,
    click_areas: &mut ClickAreas,
) {
    let area = frame.area();
    let height: u16 = 16;

    let x = area.width.saturating_sub(DIALOG_WIDTH) / 2;
    let y = area.height.saturating_sub(height) / 2;
    let dialog_area = Rect::new(x, y, DIALOG_WIDTH.min(area.width), height.min(area.height));

    frame.render_widget(Clear, dialog_area);

    let block = Block::default()
        .title(" AutoLink Configuration ")
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
        Constraint::Length(8),
        Constraint::Min(1),
        Constraint::Length(1),
    ])
    .areas(inner_area);

    frame.render_widget(
        Paragraph::new(Line::from(Span::styled(
            "  Glob patterns for auto-linking worktree files:",
            Style::default().fg(colors.text),
        ))),
        label_area,
    );

    // 渲染模式列表
    let mut lines: Vec<Line> = Vec::new();

    if data.autolink_patterns.is_empty() {
        lines.push(Line::from(Span::styled(
            "    (No patterns configured)",
            Style::default().fg(colors.muted),
        )));
    } else {
        for (i, pattern) in data.autolink_patterns.iter().enumerate() {
            let is_selected = i == data.autolink_selected;
            let prefix = if is_selected { "  \u{276f} " } else { "    " };

            let style = if is_selected {
                Style::default()
                    .fg(colors.highlight)
                    .add_modifier(Modifier::BOLD)
            } else {
                Style::default().fg(colors.text)
            };

            lines.push(Line::from(vec![
                Span::styled(prefix, style),
                Span::styled(pattern, style),
            ]));
        }
    }

    frame.render_widget(Paragraph::new(lines), content_area);

    render_hint(
        frame,
        hint_area,
        "\u{2191}\u{2193} select   a add   e edit   d delete   Esc back",
        colors,
    );

    // 注册点击区域
    click_areas.dialog_area = Some(dialog_area);
    for i in 0..data.autolink_patterns.len() {
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
        Rect::new(hint_area.x + half, hint_area.y, hint_area.width - half, 1),
        DialogAction::Cancel,
    ));
}

/// 渲染 AutoLink 编辑/添加对话框
fn render_autolink_editor(
    frame: &mut Frame,
    data: &ConfigPanelData,
    colors: &ThemeColors,
    click_areas: &mut ClickAreas,
) {
    let area = frame.area();
    let height: u16 = 11;

    let x = area.width.saturating_sub(DIALOG_WIDTH) / 2;
    let y = area.height.saturating_sub(height) / 2;
    let dialog_area = Rect::new(x, y, DIALOG_WIDTH.min(area.width), height.min(area.height));

    frame.render_widget(Clear, dialog_area);

    let title = if data.autolink_editing.is_some() {
        " Edit AutoLink Pattern "
    } else {
        " Add AutoLink Pattern "
    };

    let block = Block::default()
        .title(title)
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
        "  Glob pattern (e.g., node_modules or **/dist):",
        Style::default().fg(colors.text),
    )));
    frame.render_widget(label, label_area);

    let display_text = if data.autolink_input.is_empty() {
        "\u{2588}".to_string()
    } else {
        format!("{}\u{2588}", data.autolink_input)
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

    render_hint(frame, hint_area, "Enter save   Esc cancel", colors);

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

/// 渲染 MCP 配置说明页面
fn render_mcp_info(frame: &mut Frame, colors: &ThemeColors, click_areas: &mut ClickAreas) {
    let area = frame.area();
    let height = DIALOG_HEIGHT_MCP;

    let x = area.width.saturating_sub(DIALOG_WIDTH) / 2;
    let y = area.height.saturating_sub(height) / 2;
    let dialog_area = Rect::new(x, y, DIALOG_WIDTH.min(area.width), height.min(area.height));

    frame.render_widget(Clear, dialog_area);

    let block = Block::default()
        .title(" MCP Server ")
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

    let lines: Vec<Line> = vec![
        Line::from(Span::styled(
            "  Grove provides MCP tools for AI agents.",
            Style::default().fg(colors.text),
        )),
        Line::from(""),
        Line::from(Span::styled(
            "  MCP Server Config:",
            Style::default().fg(colors.muted),
        )),
        Line::from(""),
        Line::from(vec![
            Span::styled("    name:    ", Style::default().fg(colors.muted)),
            Span::styled("grove", Style::default().fg(colors.highlight)),
        ]),
        Line::from(vec![
            Span::styled("    type:    ", Style::default().fg(colors.muted)),
            Span::styled("stdio", Style::default().fg(colors.highlight)),
        ]),
        Line::from(vec![
            Span::styled("    command: ", Style::default().fg(colors.muted)),
            Span::styled("grove", Style::default().fg(colors.highlight)),
        ]),
        Line::from(vec![
            Span::styled("    args:    ", Style::default().fg(colors.muted)),
            Span::styled("[\"mcp\"]", Style::default().fg(colors.highlight)),
        ]),
    ];

    let list = Paragraph::new(lines);
    frame.render_widget(list, content_area);

    render_hint(frame, hint_area, "Esc back", colors);

    // 注册点击区域
    click_areas.dialog_area = Some(dialog_area);
}

/// Custom Choose 最大 pane 数
pub const CUSTOM_MAX_PANES: usize = 8;

/// 生成 title 路径描述
fn custom_title_from_path(path: &[PathSegment], root: &Option<LayoutNode>) -> String {
    if path.is_empty() {
        return "Custom Layout".to_string();
    }

    let mut parts: Vec<&str> = Vec::new();
    let mut current = root.as_ref();

    for (i, seg) in path.iter().enumerate() {
        // 获取当前 Split 的方向来决定子节点名称
        let dir = if let Some(LayoutNode::Split { dir, .. }) = current {
            Some(*dir)
        } else {
            None
        };

        let label = match (seg, dir) {
            (PathSegment::First, Some(SplitDirection::Horizontal)) => "Left",
            (PathSegment::Second, Some(SplitDirection::Horizontal)) => "Right",
            (PathSegment::First, Some(SplitDirection::Vertical)) => "Top",
            (PathSegment::Second, Some(SplitDirection::Vertical)) => "Bottom",
            (PathSegment::First, None) => "First",
            (PathSegment::Second, None) => "Second",
        };
        parts.push(label);

        // 向下遍历
        if let Some(LayoutNode::Split { first, second, .. }) = current {
            current = match seg {
                PathSegment::First => Some(first.as_ref()),
                PathSegment::Second => Some(second.as_ref()),
            };
        } else {
            break;
        }

        // 最后一段追加 "Pane"
        if i == path.len() - 1 {
            // 由 parts 最后一个元素决定
        }
    }

    format!("{} Pane", parts.join(" \u{2192} "))
}

/// 渲染 Custom Choose 页面
fn render_custom_choose(
    frame: &mut Frame,
    data: &ConfigPanelData,
    colors: &ThemeColors,
    click_areas: &mut ClickAreas,
) {
    let area = frame.area();
    let height: u16 = 18;

    let x = area.width.saturating_sub(DIALOG_WIDTH) / 2;
    let y = area.height.saturating_sub(height) / 2;
    let dialog_area = Rect::new(x, y, DIALOG_WIDTH.min(area.width), height.min(area.height));

    frame.render_widget(Clear, dialog_area);

    let title = custom_title_from_path(&data.custom_build_path, &data.custom_build_root);
    let block = Block::default()
        .title(format!(" {} ", title))
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

    let [_spacer1, label_area, _spacer2, content_area, _spacer3, pane_count_area, hint_area] =
        Layout::vertical([
            Constraint::Length(1),
            Constraint::Length(1),
            Constraint::Length(1),
            Constraint::Length(8), // 2 splits + separator + 5 leaves
            Constraint::Min(0),
            Constraint::Length(1),
            Constraint::Length(1),
        ])
        .areas(inner_area);

    frame.render_widget(
        Paragraph::new(Line::from(Span::styled(
            "  Choose pane type:",
            Style::default().fg(colors.text),
        ))),
        label_area,
    );

    // 计算当前 pane 数
    let current_panes = data
        .custom_build_root
        .as_ref()
        .map(|r| r.pane_count())
        .unwrap_or(1);
    // split 可选：split 会将 1 个 placeholder 变为 2（+1 pane），需要剩余容量 >= 2
    let can_split = current_panes < CUSTOM_MAX_PANES;

    // 选项列表：0=SplitH, 1=SplitV, 2=separator, 3=Agent, 4=Grove, 5=Shell, 6=FilePicker, 7=Custom
    let items: [(&str, bool); 8] = [
        ("Split Horizontal \u{2500}", can_split),
        ("Split Vertical   \u{2502}", can_split),
        ("\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}", false), // separator
        ("Agent", true),
        ("Grove (monitor)", true),
        ("Shell", true),
        ("FilePicker (fzf)", true),
        ("Custom command...", true),
    ];

    let mut lines: Vec<Line> = Vec::new();
    for (i, (label, enabled)) in items.iter().enumerate() {
        if i == 2 {
            // separator line
            lines.push(Line::from(Span::styled(
                format!("    {}", label),
                Style::default().fg(colors.border),
            )));
            continue;
        }

        let logical = if i < 2 { i } else { i - 1 }; // map visual to logical
        let is_selected = data.custom_choose_selected == logical;
        let prefix = if is_selected { "  \u{276f} " } else { "    " };

        let style = if !enabled {
            Style::default().fg(colors.muted)
        } else if is_selected {
            Style::default()
                .fg(colors.highlight)
                .add_modifier(Modifier::BOLD)
        } else {
            Style::default().fg(colors.text)
        };

        lines.push(Line::from(Span::styled(
            format!("{}{}", prefix, label),
            style,
        )));
    }

    frame.render_widget(Paragraph::new(lines), content_area);

    // Pane count
    frame.render_widget(
        Paragraph::new(Line::from(Span::styled(
            format!("  Panes: {}/{}", current_panes, CUSTOM_MAX_PANES),
            Style::default().fg(colors.muted),
        ))),
        pane_count_area,
    );

    render_hint(
        frame,
        hint_area,
        "\u{2191}\u{2193} select   Enter \u{25b8}   Esc \u{25c2}",
        colors,
    );

    // 注册点击区域
    click_areas.dialog_area = Some(dialog_area);
    for i in 0..items.len() {
        if i == 2 {
            continue;
        }
        let row_rect = Rect::new(
            content_area.x,
            content_area.y + i as u16,
            content_area.width,
            1,
        );
        let logical = if i < 2 { i } else { i - 1 };
        click_areas.dialog_items.push((row_rect, logical));
    }
}

/// 渲染 Custom Pane Command 输入页面
fn render_custom_pane_command(
    frame: &mut Frame,
    data: &ConfigPanelData,
    colors: &ThemeColors,
    click_areas: &mut ClickAreas,
) {
    let area = frame.area();
    let height: u16 = 11;

    let x = area.width.saturating_sub(DIALOG_WIDTH) / 2;
    let y = area.height.saturating_sub(height) / 2;
    let dialog_area = Rect::new(x, y, DIALOG_WIDTH.min(area.width), height.min(area.height));

    frame.render_widget(Clear, dialog_area);

    let block = Block::default()
        .title(" Custom Command ")
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
        "  Command to run in this pane:",
        Style::default().fg(colors.text),
    )));
    frame.render_widget(label, label_area);

    let display_text = if data.custom_cmd_input.is_empty() {
        "\u{2588}".to_string()
    } else {
        format!("{}\u{2588}", data.custom_cmd_input)
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

    render_hint(frame, hint_area, "Enter confirm   Esc back", colors);

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

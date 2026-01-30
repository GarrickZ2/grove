//! Task Monitor 视图（AgentMonitor 布局中 tmux pane 内运行）

use ratatui::{
    layout::{Alignment, Constraint, Layout, Rect},
    style::{Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Paragraph, Widget},
    Frame,
};

use crate::app::{App, MonitorAction, MonitorFocus, PreviewSubTab};
use crate::theme::ThemeColors;
use crate::ui::click_areas::ClickAreas;

use super::components::{
    commit_dialog, confirm_dialog, help_panel, input_confirm_dialog, merge_dialog, preview_panel,
    theme_selector, toast,
};

/// 展开 sidebar 宽度
const SIDEBAR_WIDTH: u16 = 20;
/// 折叠 sidebar 宽度
const SIDEBAR_COLLAPSED_WIDTH: u16 = 3;

/// 小型 logo（适配 sidebar 宽度）
const MINI_LOGO: &str = "GROVE ACTIONS";

/// 渲染 Monitor 视图
pub fn render(frame: &mut Frame, app: &mut App) {
    let area = frame.area();
    let colors = &app.colors;

    // 填充整个背景
    Block::default()
        .style(Style::default().bg(colors.bg))
        .render(area, frame.buffer_mut());

    // 根据折叠状态决定 sidebar 宽度
    let sidebar_w = if app.monitor.sidebar_collapsed {
        SIDEBAR_COLLAPSED_WIDTH
    } else {
        SIDEBAR_WIDTH
    };

    // 顶层水平分割: sidebar | content
    let [sidebar_area, content_area] =
        Layout::horizontal([Constraint::Length(sidebar_w), Constraint::Fill(1)]).areas(area);

    // 记录 click areas
    app.click_areas.monitor_sidebar_area = Some(sidebar_area);
    app.click_areas.monitor_content_area = Some(content_area);

    // 左侧 sidebar
    if app.monitor.sidebar_collapsed {
        render_sidebar_collapsed(frame, sidebar_area, colors);
    } else {
        render_sidebar(
            frame,
            sidebar_area,
            &app.monitor,
            colors,
            &mut app.click_areas,
        );
    }

    // 右侧垂直布局: header(3) + tab_bar(1) + sep(1) + content(fill) + footer(3)
    let [header_area, tab_area, sep_area, main_area, footer_area] = Layout::vertical([
        Constraint::Length(3),
        Constraint::Length(1),
        Constraint::Length(1),
        Constraint::Fill(1),
        Constraint::Length(3),
    ])
    .areas(content_area);

    render_monitor_header(frame, header_area, &app.monitor, colors);
    render_tab_bar(
        frame,
        tab_area,
        app.monitor.content_tab,
        colors,
        &mut app.click_areas,
    );

    // Separator
    let sep_text = "\u{2500}".repeat(sep_area.width as usize);
    frame.render_widget(
        Paragraph::new(Line::from(Span::styled(
            sep_text,
            Style::default().fg(colors.border),
        ))),
        sep_area,
    );

    // Content: 根据 content_tab 调用 preview_panel 公开函数
    match app.monitor.content_tab {
        PreviewSubTab::Git => preview_panel::render_git_tab(
            frame,
            main_area,
            &app.monitor.panel_data,
            app.monitor.git_scroll,
            colors,
        ),
        PreviewSubTab::Ai => preview_panel::render_ai_tab(
            frame,
            main_area,
            &app.monitor.panel_data,
            app.monitor.ai_summary_scroll,
            colors,
        ),
        PreviewSubTab::Notes => preview_panel::render_notes_tab(
            frame,
            main_area,
            &app.monitor.panel_data,
            app.monitor.notes_scroll,
            colors,
        ),
    }

    render_monitor_footer(frame, footer_area, &app.monitor, colors);

    // 渲染 Toast
    if let Some(ref msg) = app.loading_message {
        toast::render_loading(frame, msg, colors);
    } else if let Some(ref t) = app.toast {
        if !t.is_expired() {
            toast::render(frame, &t.message, colors);
        }
    }

    // 渲染覆盖弹窗
    if app.show_theme_selector {
        theme_selector::render(
            frame,
            app.theme_selector_index,
            colors,
            &mut app.click_areas,
        );
    }
    if let Some(ref confirm_type) = app.confirm_dialog {
        confirm_dialog::render(frame, confirm_type, colors, &mut app.click_areas);
    }
    if let Some(ref data) = app.input_confirm_dialog {
        input_confirm_dialog::render(frame, data, colors, &mut app.click_areas);
    }
    if let Some(ref data) = app.merge_dialog {
        merge_dialog::render(frame, data, colors, &mut app.click_areas);
    }
    if let Some(ref data) = app.commit_dialog {
        commit_dialog::render(frame, data, colors, &mut app.click_areas);
    }
    if app.show_help {
        help_panel::render(frame, colors, app.update_info.as_ref());
    }
}

/// 渲染折叠状态的 sidebar（窄条）
fn render_sidebar_collapsed(frame: &mut Frame, area: Rect, colors: &ThemeColors) {
    let block = Block::default()
        .borders(Borders::RIGHT)
        .border_style(Style::default().fg(colors.border))
        .style(Style::default().bg(colors.bg));

    let inner = block.inner(area);
    frame.render_widget(block, area);

    // 竖排显示 "G" 标识
    if inner.height > 0 && inner.width > 0 {
        let g_area = Rect::new(inner.x, inner.y, inner.width, 1);
        frame.render_widget(
            Paragraph::new(Line::from(Span::styled(
                "\u{25b8}",
                Style::default()
                    .fg(colors.highlight)
                    .add_modifier(Modifier::BOLD),
            )))
            .alignment(Alignment::Center),
            g_area,
        );
    }
}

/// 渲染展开状态的左侧 sidebar（操作栏）
fn render_sidebar(
    frame: &mut Frame,
    area: Rect,
    monitor: &crate::app::MonitorState,
    colors: &ThemeColors,
    click_areas: &mut ClickAreas,
) {
    let border_color = if monitor.focus == MonitorFocus::Sidebar {
        colors.highlight
    } else {
        colors.border
    };

    let block = Block::default()
        .borders(Borders::ALL)
        .border_style(Style::default().fg(border_color))
        .style(Style::default().bg(colors.bg));

    let inner = block.inner(area);
    frame.render_widget(block, area);

    let mut y = inner.y;

    // Logo 标题
    if y < inner.y + inner.height {
        let row = Rect::new(inner.x, y, inner.width, 1);
        frame.render_widget(
            Paragraph::new(Line::from(Span::styled(
                MINI_LOGO,
                Style::default()
                    .fg(colors.logo)
                    .add_modifier(Modifier::BOLD),
            )))
            .alignment(Alignment::Center),
            row,
        );
        y += 1;
    }

    // 空行
    y += 1;

    // 按 group 渲染 actions，每组带 section header
    let groups = MonitorAction::groups();
    let mut flat_idx: usize = 0;
    let btn_width = inner.width.min(16); // button 最大宽度
    let btn_x = inner.x + (inner.width.saturating_sub(btn_width)) / 2; // 居中

    for (gi, (section_label, group)) in groups.iter().enumerate() {
        if y >= inner.y + inner.height {
            break;
        }

        // Section header: "── Git ──" 风格
        let label_len = section_label.len();
        let deco_total = btn_width as usize - label_len - 2; // 减去 " label " 两边空格
        let deco_left = deco_total / 2;
        let deco_right = deco_total - deco_left;
        let left_line = "\u{2500}".repeat(deco_left);
        let right_line = "\u{2500}".repeat(deco_right);

        let header_row = Rect::new(btn_x, y, btn_width, 1);
        frame.render_widget(
            Paragraph::new(Line::from(vec![
                Span::styled(&left_line, Style::default().fg(colors.border)),
                Span::styled(
                    format!(" {} ", section_label),
                    Style::default()
                        .fg(colors.muted)
                        .add_modifier(Modifier::BOLD),
                ),
                Span::styled(&right_line, Style::default().fg(colors.border)),
            ]))
            .alignment(Alignment::Center),
            header_row,
        );
        y += 1;

        for action in *group {
            if y >= inner.y + inner.height {
                break;
            }
            let is_selected =
                flat_idx == monitor.action_selected && monitor.focus == MonitorFocus::Sidebar;

            let label = action.label();
            // 居中 pad: "[ Commit  ]"
            let inner_w = btn_width.saturating_sub(4) as usize; // 去掉 "[ " 和 " ]"
            let padded = format!("{:^w$}", label, w = inner_w);
            let btn_text = format!("[ {} ]", padded);

            let row_area = Rect::new(btn_x, y, btn_width, 1);

            // 记录可点击区域
            click_areas.monitor_actions.push((row_area, flat_idx));

            if is_selected {
                // 选中：高亮背景 + 前景文字
                frame.render_widget(
                    Paragraph::new(Line::from(Span::styled(
                        btn_text,
                        Style::default()
                            .fg(colors.bg)
                            .bg(colors.highlight)
                            .add_modifier(Modifier::BOLD),
                    )))
                    .alignment(Alignment::Center),
                    row_area,
                );
            } else {
                // 未选中：方括号边框 + 普通文字
                frame.render_widget(
                    Paragraph::new(Line::from(vec![
                        Span::styled("[", Style::default().fg(colors.muted)),
                        Span::styled(format!(" {} ", padded), Style::default().fg(colors.text)),
                        Span::styled("]", Style::default().fg(colors.muted)),
                    ]))
                    .alignment(Alignment::Center),
                    row_area,
                );
            }

            y += 1;
            flat_idx += 1;
        }

        // 组间额外空行（最后一组不加）
        if gi < groups.len() - 1 {
            y += 1;
        }
    }
}

/// 渲染 Monitor header（任务名 + 分支信息）
fn render_monitor_header(
    frame: &mut Frame,
    area: Rect,
    monitor: &crate::app::MonitorState,
    colors: &ThemeColors,
) {
    let block = Block::default()
        .borders(Borders::ALL)
        .border_style(Style::default().fg(colors.border))
        .style(Style::default().bg(colors.bg));

    let inner = block.inner(area);
    frame.render_widget(block, area);

    let mut lines: Vec<Line> = Vec::new();

    // Task name
    let task_display = if monitor.task_name.is_empty() {
        "Monitor".to_string()
    } else {
        monitor.task_name.clone()
    };

    lines.push(Line::from(vec![
        Span::styled(" \u{25cf} ", Style::default().fg(colors.status_live)),
        Span::styled(
            task_display,
            Style::default()
                .fg(colors.highlight)
                .add_modifier(Modifier::BOLD),
        ),
    ]));

    // Branch → Target
    if !monitor.branch.is_empty() {
        lines.push(Line::from(vec![
            Span::styled("   ", Style::default()),
            Span::styled(&monitor.branch, Style::default().fg(colors.text)),
            Span::styled(" \u{2192} ", Style::default().fg(colors.muted)),
            Span::styled(&monitor.target, Style::default().fg(colors.muted)),
        ]));
    }

    let paragraph = Paragraph::new(lines);
    frame.render_widget(paragraph, inner);
}

/// 渲染 tab bar
fn render_tab_bar(
    frame: &mut Frame,
    area: Rect,
    active: PreviewSubTab,
    colors: &ThemeColors,
    click_areas: &mut ClickAreas,
) {
    let tabs = [
        (PreviewSubTab::Git, "1:Git"),
        (PreviewSubTab::Ai, "2:AI"),
        (PreviewSubTab::Notes, "3:Notes"),
    ];

    let mut spans = Vec::new();
    spans.push(Span::raw(" "));

    // 记录 tab 点击区域
    let mut x_offset = area.x + 1; // leading " "
    for (i, (tab, label)) in tabs.iter().enumerate() {
        let tab_width = (label.len() + 2) as u16; // "[label]" or " label "
        let tab_rect = Rect::new(x_offset, area.y, tab_width, 1);
        click_areas.monitor_tabs.push((tab_rect, *tab));
        x_offset += tab_width;

        if *tab == active {
            spans.push(Span::styled(
                format!("[{}]", label),
                Style::default()
                    .fg(colors.highlight)
                    .add_modifier(Modifier::BOLD),
            ));
        } else {
            spans.push(Span::styled(
                format!(" {} ", label),
                Style::default().fg(colors.muted),
            ));
        }
        if i < tabs.len() - 1 {
            spans.push(Span::styled("  ", Style::default().fg(colors.muted)));
            x_offset += 2; // separator "  "
        }
    }

    frame.render_widget(Paragraph::new(Line::from(spans)), area);
}

/// 渲染 Monitor footer
fn render_monitor_footer(
    frame: &mut Frame,
    area: Rect,
    monitor: &crate::app::MonitorState,
    colors: &ThemeColors,
) {
    let hints = if monitor.sidebar_collapsed {
        // 折叠时只显示展开提示 + 内容操作
        let mut h = vec![
            ("Tab", "unfold"),
            ("1/2/3", "tab"),
            ("j/k", "scroll"),
            ("r", "refresh"),
        ];
        if monitor.content_tab == PreviewSubTab::Notes {
            h.push(("i", "edit"));
        }
        h.push(("q", "quit"));
        h
    } else {
        match monitor.focus {
            MonitorFocus::Sidebar => {
                vec![
                    ("Tab", "fold"),
                    ("h/l", "focus"),
                    ("j/k", "select"),
                    ("Enter", "run"),
                    ("r", "refresh"),
                    ("q", "quit"),
                ]
            }
            MonitorFocus::Content => {
                let mut h = vec![
                    ("Tab", "fold"),
                    ("h/l", "focus"),
                    ("1/2/3", "tab"),
                    ("j/k", "scroll"),
                    ("r", "refresh"),
                ];
                if monitor.content_tab == PreviewSubTab::Notes {
                    h.push(("i", "edit"));
                }
                h.push(("q", "quit"));
                h
            }
        }
    };

    let block = Block::default()
        .borders(Borders::ALL)
        .border_style(Style::default().fg(colors.border))
        .style(Style::default().bg(colors.bg));

    let inner = block.inner(area);
    frame.render_widget(block, area);

    let mut spans = Vec::new();
    let max_w = inner.width as usize;
    let mut used: usize = 0;

    for (i, (key, desc)) in hints.iter().enumerate() {
        // 计算本条 hint 需要的宽度: "key desc" + 分隔 "  "
        let hint_w = key.len() + 1 + desc.len();
        let sep_w = if i < hints.len() - 1 { 2 } else { 0 };
        if used + hint_w + sep_w > max_w && i > 0 {
            break;
        }
        spans.push(Span::styled(
            *key,
            Style::default()
                .fg(colors.highlight)
                .add_modifier(Modifier::BOLD),
        ));
        spans.push(Span::styled(
            format!(" {}", desc),
            Style::default().fg(colors.muted),
        ));
        used += hint_w;
        if i < hints.len() - 1 {
            spans.push(Span::raw("  "));
            used += 2;
        }
    }

    let paragraph = Paragraph::new(Line::from(spans)).alignment(Alignment::Center);
    frame.render_widget(paragraph, inner);
}

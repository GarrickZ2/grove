use ratatui::{
    layout::{Alignment, Constraint, Layout, Rect},
    style::{Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Paragraph, Wrap},
    Frame,
};

use crate::app::{PanelData, PreviewSubTab};
use crate::model::{Worktree, WorktreeStatus};
use crate::theme::ThemeColors;

const SPINNER_FRAMES: &[char] = &['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/// 渲染预览面板
#[allow(clippy::too_many_arguments)]
pub fn render(
    frame: &mut Frame,
    area: Rect,
    worktree: Option<&Worktree>,
    sub_tab: PreviewSubTab,
    panel_data: &PanelData,
    notes_scroll: u16,
    ai_summary_scroll: u16,
    git_scroll: u16,
    colors: &ThemeColors,
) {
    let (title, border_color) = if let Some(wt) = worktree {
        let icon = wt.status.icon();
        let title = format!(" {} {} ", icon, wt.task_name);
        let color = match wt.status {
            WorktreeStatus::Live => colors.status_live,
            WorktreeStatus::Merged => colors.status_merged,
            _ => colors.muted,
        };
        (title, color)
    } else {
        (" Info ".to_string(), colors.muted)
    };

    let block = Block::default()
        .title(title)
        .title_style(
            Style::default()
                .fg(border_color)
                .add_modifier(Modifier::BOLD),
        )
        .borders(Borders::ALL)
        .border_style(Style::default().fg(colors.border));

    let inner = block.inner(area);
    frame.render_widget(block, area);

    if inner.width < 4 || inner.height < 4 {
        return;
    }

    if worktree.is_none() {
        render_no_selection(frame, inner, colors);
        return;
    }

    // Sub-tab bar (1 line) + separator (1 line) + content
    let [tab_bar_area, sep_area, content_area] = Layout::vertical([
        Constraint::Length(1),
        Constraint::Length(1),
        Constraint::Fill(1),
    ])
    .areas(inner);

    // Render sub-tab bar
    render_sub_tab_bar(frame, tab_bar_area, sub_tab, colors);

    // Render separator
    let sep_text = "─".repeat(sep_area.width as usize);
    frame.render_widget(
        Paragraph::new(Line::from(Span::styled(
            sep_text,
            Style::default().fg(colors.border),
        ))),
        sep_area,
    );

    // Render content
    match sub_tab {
        PreviewSubTab::Git => render_git_tab(frame, content_area, panel_data, git_scroll, colors),
        PreviewSubTab::Ai => {
            render_ai_tab(frame, content_area, panel_data, ai_summary_scroll, colors)
        }
        PreviewSubTab::Notes => {
            render_notes_tab(frame, content_area, panel_data, notes_scroll, colors)
        }
    }
}

fn render_sub_tab_bar(frame: &mut Frame, area: Rect, active: PreviewSubTab, colors: &ThemeColors) {
    let tabs = [
        (PreviewSubTab::Git, "1:Git"),
        (PreviewSubTab::Ai, "2:AI"),
        (PreviewSubTab::Notes, "3:Notes"),
    ];

    let mut left_spans = Vec::new();
    left_spans.push(Span::raw(" "));

    for (i, (tab, label)) in tabs.iter().enumerate() {
        if *tab == active {
            left_spans.push(Span::styled(
                format!("[{}]", label),
                Style::default()
                    .fg(colors.highlight)
                    .add_modifier(Modifier::BOLD),
            ));
        } else {
            left_spans.push(Span::styled(
                format!(" {} ", label),
                Style::default().fg(colors.muted),
            ));
        }
        if i < tabs.len() - 1 {
            left_spans.push(Span::styled("  ", Style::default().fg(colors.muted)));
        }
    }

    // Right-aligned hint
    let hint = "j/k scroll";
    let left_width: usize = left_spans.iter().map(|s| s.width()).sum();
    let hint_width = hint.len() + 1; // +1 for trailing space
    if area.width as usize > left_width + hint_width {
        let pad = area.width as usize - left_width - hint_width;
        left_spans.push(Span::raw(" ".repeat(pad)));
        left_spans.push(Span::styled(
            format!("{} ", hint),
            Style::default().fg(colors.muted),
        ));
    }

    frame.render_widget(Paragraph::new(Line::from(left_spans)), area);
}

fn render_git_tab(frame: &mut Frame, area: Rect, data: &PanelData, scroll: u16, colors: &ThemeColors) {
    let mut lines: Vec<Line> = Vec::new();

    // Branch → Target
    lines.push(Line::from(vec![
        Span::styled(" ", Style::default()),
        Span::styled(
            &data.git_branch,
            Style::default()
                .fg(colors.highlight)
                .add_modifier(Modifier::BOLD),
        ),
        Span::styled(" → ", Style::default().fg(colors.muted)),
        Span::styled(&data.git_target, Style::default().fg(colors.text)),
    ]));
    lines.push(Line::from(""));

    // Merge conflict warning
    if data.git_has_conflicts {
        lines.push(Line::from(Span::styled(
            " ⚠ Merge conflict",
            Style::default()
                .fg(colors.status_merged)
                .add_modifier(Modifier::BOLD),
        )));
        lines.push(Line::from(""));
    }

    // Recent Commits
    lines.push(Line::from(Span::styled(
        " Recent Commits",
        Style::default()
            .fg(colors.highlight)
            .add_modifier(Modifier::BOLD),
    )));

    if data.git_log.is_empty() {
        lines.push(Line::from(Span::styled(
            "   No commits ahead of target",
            Style::default().fg(colors.muted),
        )));
    } else {
        for entry in &data.git_log {
            let time_width = 12;
            let time = format!(" {:>width$}", entry.time_ago, width = time_width);
            lines.push(Line::from(vec![
                Span::styled(time, Style::default().fg(colors.muted)),
                Span::raw("  "),
                Span::styled(&entry.message, Style::default().fg(colors.text)),
            ]));
        }
    }

    lines.push(Line::from(""));

    // Changed Files (with total stats)
    let total_add: u32 = data.git_diff.iter().map(|e| e.additions).sum();
    let total_del: u32 = data.git_diff.iter().map(|e| e.deletions).sum();
    if data.git_diff.is_empty() {
        lines.push(Line::from(Span::styled(
            " Changed Files",
            Style::default()
                .fg(colors.highlight)
                .add_modifier(Modifier::BOLD),
        )));
        lines.push(Line::from(Span::styled(
            "   No changes vs target",
            Style::default().fg(colors.muted),
        )));
    } else {
        lines.push(Line::from(vec![
            Span::styled(
                " Changed Files",
                Style::default()
                    .fg(colors.highlight)
                    .add_modifier(Modifier::BOLD),
            ),
            Span::styled(
                format!("  (+{} -{})", total_add, total_del),
                Style::default().fg(colors.muted),
            ),
        ]));
        for entry in &data.git_diff {
            let status_style = match entry.status {
                'A' => Style::default().fg(colors.status_live),
                'D' => Style::default().fg(colors.status_merged),
                _ => Style::default().fg(colors.highlight),
            };
            let stat = format!("+{} -{}", entry.additions, entry.deletions);
            // Truncate path to fit
            let max_path = (area.width as usize).saturating_sub(20);
            let path = if entry.path.len() > max_path {
                format!("…{}", &entry.path[entry.path.len() - max_path + 1..])
            } else {
                entry.path.clone()
            };
            lines.push(Line::from(vec![
                Span::raw(" "),
                Span::styled(format!("{}", entry.status), status_style),
                Span::raw(" "),
                Span::styled(path, Style::default().fg(colors.text)),
                Span::raw("  "),
                Span::styled(stat, Style::default().fg(colors.muted)),
            ]));
        }
    }

    // Status indicators
    let mut status_items: Vec<String> = Vec::new();
    if data.git_uncommitted > 0 {
        status_items.push(format!("{} uncommitted", data.git_uncommitted));
    }
    if data.git_stash_count > 0 {
        status_items.push(format!("{} stash", data.git_stash_count));
    }
    if !status_items.is_empty() {
        lines.push(Line::from(""));
        lines.push(Line::from(Span::styled(
            format!(" ● {}", status_items.join("  ● ")),
            Style::default().fg(colors.highlight),
        )));
    }

    let paragraph = Paragraph::new(lines)
        .wrap(Wrap { trim: false })
        .scroll((scroll, 0));
    frame.render_widget(paragraph, area);
}

fn render_ai_tab(
    frame: &mut Frame,
    area: Rect,
    data: &PanelData,
    summary_scroll: u16,
    colors: &ThemeColors,
) {
    if !data.ai_initialized {
        render_ai_not_init(frame, area, colors);
        return;
    }

    // Calculate TODO height: 1 header + items, capped at 40% of area, min 3
    let todo_item_count = data.ai_todo.todo.len() + data.ai_todo.done.len();
    let todo_content_height = if data.ai_todo.is_empty() {
        2 // header + "No items yet"
    } else {
        1 + todo_item_count // header + items
    };
    let max_todo = (area.height as usize * 40 / 100).max(3);
    let todo_height = todo_content_height.min(max_todo).max(3) as u16;

    let [summary_area, sep_area, todo_area] = Layout::vertical([
        Constraint::Fill(1),
        Constraint::Length(1),
        Constraint::Length(todo_height),
    ])
    .areas(area);

    render_ai_summary(frame, summary_area, data, summary_scroll, colors);

    // Separator line
    let sep_text = "─".repeat(sep_area.width as usize);
    frame.render_widget(
        Paragraph::new(Line::from(Span::styled(
            sep_text,
            Style::default().fg(colors.border),
        ))),
        sep_area,
    );

    render_ai_todo(frame, todo_area, data, colors);
}

fn render_ai_summary(
    frame: &mut Frame,
    area: Rect,
    data: &PanelData,
    scroll: u16,
    colors: &ThemeColors,
) {
    let mut lines: Vec<Line> = Vec::new();

    lines.push(Line::from(Span::styled(
        " Summary",
        Style::default()
            .fg(colors.highlight)
            .add_modifier(Modifier::BOLD),
    )));

    if data.ai_summary.is_empty() {
        lines.push(Line::from(Span::styled(
            "   No summary yet",
            Style::default().fg(colors.muted),
        )));
    } else {
        for line in data.ai_summary.lines() {
            lines.push(Line::from(Span::styled(
                format!(" {}", line),
                Style::default().fg(colors.text),
            )));
        }
    }

    let paragraph = Paragraph::new(lines)
        .wrap(Wrap { trim: false })
        .scroll((scroll, 0));
    frame.render_widget(paragraph, area);
}

fn render_ai_todo(frame: &mut Frame, area: Rect, data: &PanelData, colors: &ThemeColors) {
    let mut lines: Vec<Line> = Vec::new();

    // TODO header with optional spinner
    if data.ai_todo_active {
        let frame_idx = (std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .subsec_millis()
            / 100) as usize
            % SPINNER_FRAMES.len();
        lines.push(Line::from(vec![
            Span::styled(
                " TODO ",
                Style::default()
                    .fg(colors.highlight)
                    .add_modifier(Modifier::BOLD),
            ),
            Span::styled(
                SPINNER_FRAMES[frame_idx].to_string(),
                Style::default().fg(colors.highlight),
            ),
        ]));
    } else {
        lines.push(Line::from(Span::styled(
            " TODO",
            Style::default()
                .fg(colors.highlight)
                .add_modifier(Modifier::BOLD),
        )));
    }

    if data.ai_todo.is_empty() {
        lines.push(Line::from(Span::styled(
            "   No items yet",
            Style::default().fg(colors.muted),
        )));
    } else {
        for item in &data.ai_todo.todo {
            lines.push(Line::from(vec![
                Span::styled(" □ ", Style::default().fg(colors.text)),
                Span::styled(item, Style::default().fg(colors.text)),
            ]));
        }
        for item in &data.ai_todo.done {
            lines.push(Line::from(vec![
                Span::styled(" ✓ ", Style::default().fg(colors.status_merged)),
                Span::styled(item, Style::default().fg(colors.muted)),
            ]));
        }
    }

    let paragraph = Paragraph::new(lines).wrap(Wrap { trim: false });
    frame.render_widget(paragraph, area);
}

fn render_ai_not_init(frame: &mut Frame, area: Rect, colors: &ThemeColors) {
    let [_, center, _] = Layout::vertical([
        Constraint::Percentage(30),
        Constraint::Length(5),
        Constraint::Percentage(30),
    ])
    .areas(area);

    let lines = vec![
        Line::from(Span::styled(
            "AI integration not available for this task.",
            Style::default().fg(colors.muted),
        )),
        Line::from(""),
        Line::from(Span::styled(
            "New tasks will be set up automatically.",
            Style::default().fg(colors.muted),
        )),
    ];

    let paragraph = Paragraph::new(lines).alignment(Alignment::Center);
    frame.render_widget(paragraph, center);
}

fn render_notes_tab(
    frame: &mut Frame,
    area: Rect,
    data: &PanelData,
    scroll: u16,
    colors: &ThemeColors,
) {
    let content = &data.notes_content;

    // Content area minus hint line
    let [text_area, hint_area] =
        Layout::vertical([Constraint::Fill(1), Constraint::Length(1)]).areas(area);

    if content.is_empty() {
        let [_, center, _] = Layout::vertical([
            Constraint::Percentage(35),
            Constraint::Length(2),
            Constraint::Percentage(35),
        ])
        .areas(text_area);

        let lines = vec![
            Line::from(Span::styled(
                "No notes yet.",
                Style::default().fg(colors.muted),
            )),
            Line::from(Span::styled(
                "Press i to edit.",
                Style::default().fg(colors.muted),
            )),
        ];
        frame.render_widget(Paragraph::new(lines).alignment(Alignment::Center), center);
    } else {
        let mut lines: Vec<Line> = Vec::new();
        for line in content.lines() {
            lines.push(Line::from(Span::styled(
                format!(" {}", line),
                Style::default().fg(colors.text),
            )));
        }
        let paragraph = Paragraph::new(lines)
            .wrap(Wrap { trim: false })
            .scroll((scroll, 0));
        frame.render_widget(paragraph, text_area);
    }

    // Hint at bottom
    frame.render_widget(
        Paragraph::new(Line::from(Span::styled(
            " [i] edit ",
            Style::default().fg(colors.muted),
        )))
        .alignment(Alignment::Right),
        hint_area,
    );
}

fn render_no_selection(frame: &mut Frame, area: Rect, colors: &ThemeColors) {
    let [_, center, _] = Layout::vertical([
        Constraint::Percentage(45),
        Constraint::Length(1),
        Constraint::Percentage(45),
    ])
    .areas(area);

    let paragraph = Paragraph::new(Line::from(Span::styled(
        "No task selected",
        Style::default().fg(colors.muted),
    )))
    .alignment(Alignment::Center);
    frame.render_widget(paragraph, center);
}

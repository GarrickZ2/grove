use ratatui::{
    layout::{Alignment, Constraint, Layout, Rect},
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Paragraph, Wrap},
    Frame,
};

use crate::app::{PanelData, PreviewSubTab};
use crate::model::{Worktree, WorktreeStatus};
use crate::storage::comments::CommentStatus;
use crate::theme::ThemeColors;
use crate::ui::click_areas::ClickAreas;
use crate::watcher::TaskEditHistory;

/// 渲染预览面板
#[allow(clippy::too_many_arguments)]
pub fn render(
    frame: &mut Frame,
    area: Rect,
    worktree: Option<&Worktree>,
    sub_tab: PreviewSubTab,
    panel_data: &PanelData,
    notes_scroll: u16,
    git_scroll: u16,
    diff_scroll: u16,
    stats_scroll: u16,
    stats_history: Option<&TaskEditHistory>,
    colors: &ThemeColors,
    click_areas: &mut ClickAreas,
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
    render_sub_tab_bar(frame, tab_bar_area, sub_tab, colors, click_areas);

    // Render separator
    let sep_text = "─".repeat(sep_area.width as usize);
    frame.render_widget(
        Paragraph::new(Line::from(Span::styled(
            sep_text,
            Style::default().fg(colors.border),
        ))),
        sep_area,
    );

    // Render content (Tab order: Stats, Git, Notes, Review)
    match sub_tab {
        PreviewSubTab::Stats => {
            render_stats_tab(frame, content_area, stats_history, stats_scroll, colors)
        }
        PreviewSubTab::Git => render_git_tab(frame, content_area, panel_data, git_scroll, colors),
        PreviewSubTab::Notes => {
            render_notes_tab(frame, content_area, panel_data, notes_scroll, colors)
        }
        PreviewSubTab::Diff => {
            render_diff_tab(frame, content_area, panel_data, diff_scroll, colors)
        }
    }
}

fn render_sub_tab_bar(
    frame: &mut Frame,
    area: Rect,
    active: PreviewSubTab,
    colors: &ThemeColors,
    click_areas: &mut ClickAreas,
) {
    let tabs = [
        (PreviewSubTab::Stats, "1:Stats"),
        (PreviewSubTab::Git, "2:Git"),
        (PreviewSubTab::Notes, "3:Notes"),
        (PreviewSubTab::Diff, "4:Review"),
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

    // 记录子 tab 点击区域
    let mut x_offset = area.x + 1; // leading " "
    for (i, (tab, label)) in tabs.iter().enumerate() {
        let tab_width = (label.len() + 2) as u16; // "[label]" or " label "
        let tab_rect = Rect::new(x_offset, area.y, tab_width, 1);
        click_areas.preview_sub_tabs.push((tab_rect, *tab));
        x_offset += tab_width;
        if i < tabs.len() - 1 {
            x_offset += 2; // separator "  "
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

pub fn render_git_tab(
    frame: &mut Frame,
    area: Rect,
    data: &PanelData,
    scroll: u16,
    colors: &ThemeColors,
) {
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
            // Truncate path to fit (use char count for UTF-8 safety)
            let max_path = (area.width as usize).saturating_sub(20);
            let char_count = entry.path.chars().count();
            let path = if char_count > max_path && max_path > 1 {
                let skip = char_count - max_path + 1;
                format!("…{}", entry.path.chars().skip(skip).collect::<String>())
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

pub fn render_notes_tab(
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

pub fn render_diff_tab(
    frame: &mut Frame,
    area: Rect,
    data: &PanelData,
    scroll: u16,
    colors: &ThemeColors,
) {
    if data.review_comments.is_empty() {
        let [_, center, _] = Layout::vertical([
            Constraint::Percentage(30),
            Constraint::Length(4),
            Constraint::Percentage(30),
        ])
        .areas(area);

        let lines = vec![
            Line::from(Span::styled(
                "No review comments yet.",
                Style::default().fg(colors.muted),
            )),
            Line::from(""),
            Line::from(Span::styled(
                "Press d to open diff review in browser.",
                Style::default().fg(colors.muted),
            )),
        ];
        frame.render_widget(Paragraph::new(lines).alignment(Alignment::Center), center);
        return;
    }

    let mut lines: Vec<Line> = Vec::new();

    // Header with counts
    let (open, resolved, outdated) = data.review_comments.count_by_status();
    lines.push(Line::from(vec![
        Span::styled(
            " Review Comments",
            Style::default()
                .fg(colors.highlight)
                .add_modifier(Modifier::BOLD),
        ),
        Span::styled(
            format!(
                "  ({} open, {} resolved, {} outdated)",
                open, resolved, outdated
            ),
            Style::default().fg(colors.muted),
        ),
    ]));
    lines.push(Line::from(""));

    // Render each comment
    for comment in &data.review_comments.comments {
        // Comment header with ID and status
        let loc = format!("{}:{}", comment.file_path, comment.start_line);
        match comment.status {
            CommentStatus::Open => {
                lines.push(Line::from(vec![
                    Span::styled(
                        format!(" [#{}] ", comment.id),
                        Style::default()
                            .fg(colors.highlight)
                            .add_modifier(Modifier::BOLD),
                    ),
                    Span::styled(loc.clone(), Style::default().fg(colors.highlight)),
                ]));
            }
            CommentStatus::Resolved => {
                lines.push(Line::from(vec![
                    Span::styled(
                        format!(" [#{}] ", comment.id),
                        Style::default()
                            .fg(colors.status_merged)
                            .add_modifier(Modifier::BOLD),
                    ),
                    Span::styled(
                        "✓ RESOLVED ",
                        Style::default()
                            .fg(colors.status_merged)
                            .add_modifier(Modifier::BOLD),
                    ),
                    Span::styled(format!("~~{}~~", &loc), Style::default().fg(colors.muted)),
                ]));
            }
            CommentStatus::Outdated => {
                lines.push(Line::from(vec![
                    Span::styled(
                        format!(" [#{}] ", comment.id),
                        Style::default()
                            .fg(Color::Yellow)
                            .add_modifier(Modifier::BOLD),
                    ),
                    Span::styled(
                        "OUTDATED ",
                        Style::default()
                            .fg(Color::Yellow)
                            .add_modifier(Modifier::BOLD),
                    ),
                    Span::styled(loc.clone(), Style::default().fg(colors.highlight)),
                ]));
            }
        }

        // Comment content
        let content_style = if comment.status == CommentStatus::Resolved {
            Style::default().fg(colors.muted)
        } else {
            Style::default().fg(colors.text)
        };

        for content_line in comment.content.lines() {
            let display_text = if comment.status == CommentStatus::Resolved {
                format!(" │ ~~{}~~", content_line)
            } else {
                format!(" │ {}", content_line)
            };
            lines.push(Line::from(Span::styled(display_text, content_style)));
        }

        // Replies
        if comment.replies.is_empty() {
            if comment.status == CommentStatus::Open {
                lines.push(Line::from(Span::styled(
                    " └─ (no reply)",
                    Style::default().fg(colors.muted),
                )));
            }
        } else {
            let reply_style = Style::default().fg(colors.status_merged);
            for reply in &comment.replies {
                for (i, reply_line) in reply.content.lines().enumerate() {
                    let prefix = if i == 0 {
                        format!(" └─ {}: ", reply.author)
                    } else {
                        "        ".to_string()
                    };
                    lines.push(Line::from(Span::styled(
                        format!("{}{}", prefix, reply_line),
                        reply_style,
                    )));
                }
            }
        }

        // Separator between comments
        lines.push(Line::from(""));
    }

    let paragraph = Paragraph::new(lines)
        .wrap(Wrap { trim: false })
        .scroll((scroll, 0));
    frame.render_widget(paragraph, area);
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

pub fn render_stats_tab(
    frame: &mut Frame,
    area: Rect,
    history: Option<&TaskEditHistory>,
    scroll: u16,
    colors: &ThemeColors,
) {
    let Some(history) = history else {
        // No stats data available
        let [_, center, _] = Layout::vertical([
            Constraint::Percentage(45),
            Constraint::Length(1),
            Constraint::Percentage(45),
        ])
        .areas(area);

        let paragraph = Paragraph::new(Line::from(Span::styled(
            "No activity data yet",
            Style::default().fg(colors.muted),
        )))
        .alignment(Alignment::Center);
        frame.render_widget(paragraph, center);
        return;
    };

    let mut lines: Vec<Line> = Vec::new();

    // === File Edits Section ===
    lines.push(Line::from(Span::styled(
        " File Edits",
        Style::default()
            .fg(colors.highlight)
            .add_modifier(Modifier::BOLD),
    )));
    lines.push(Line::from(""));

    let files = history.files_by_count();
    let max_count = files.first().map(|(_, c)| *c).unwrap_or(1);

    if files.is_empty() {
        lines.push(Line::from(Span::styled(
            "   No file edits recorded",
            Style::default().fg(colors.muted),
        )));
    } else {
        // Calculate available width for path display
        // Layout: "   " (3) + path + " " (1) + bar (max 25) + " " (1) + count (max 5)
        let path_max_width = (area.width as usize).saturating_sub(35).max(20);
        let bar_max_width = 25;

        // Show top 10 files with color gradient based on intensity
        for (path, count) in files.iter().take(10) {
            let path_str = path.to_string_lossy();
            let bar_width = if max_count > 0 {
                ((count * bar_max_width as u32) / max_count).max(1) as usize
            } else {
                1
            };
            let bar = "█".repeat(bar_width);

            // Color gradient: more edits = warmer color
            let ratio = if max_count > 0 {
                *count as f32 / max_count as f32
            } else {
                0.0
            };
            let bar_color = if ratio > 0.8 {
                Color::Rgb(255, 100, 100) // Hot - red/coral
            } else if ratio > 0.5 {
                Color::Rgb(255, 180, 50) // Warm - orange
            } else if ratio > 0.25 {
                Color::Rgb(100, 200, 100) // Medium - green
            } else {
                Color::Rgb(80, 160, 180) // Cool - teal
            };

            let display_path = compact_path(&path_str, path_max_width);
            lines.push(Line::from(vec![
                Span::styled("   ", Style::default()),
                Span::styled(
                    format!("{:<width$}", display_path, width = path_max_width),
                    Style::default().fg(colors.text),
                ),
                Span::styled(format!(" {} ", bar), Style::default().fg(bar_color)),
                Span::styled(format!("{}", count), Style::default().fg(colors.muted)),
            ]));
        }
    }

    lines.push(Line::from(""));

    // === Activity Timeline Section ===
    lines.push(Line::from(Span::styled(
        " Activity Timeline",
        Style::default()
            .fg(colors.highlight)
            .add_modifier(Modifier::BOLD),
    )));
    lines.push(Line::from(""));

    let timeline = history.activity_timeline();
    if timeline.is_empty() {
        lines.push(Line::from(Span::styled(
            "   No activity recorded",
            Style::default().fg(colors.muted),
        )));
    } else {
        // Calculate max buckets that fit: area.width - prefix (3 + 6 for "   HH:MM ")
        // Each bucket is 2 chars wide. Add extra 3 chars margin for safety.
        let max_buckets = ((area.width as usize).saturating_sub(12) / 2).min(60);

        for (hour, buckets) in timeline.iter().rev().take(6) {
            // Convert UTC to local time for display
            let local_hour = hour.with_timezone(&chrono::Local);
            let hour_str = local_hour.format("%H:%M").to_string();
            let mut bucket_spans = vec![
                Span::styled("   ", Style::default()),
                Span::styled(format!("{} ", hour_str), Style::default().fg(colors.muted)),
            ];

            // Find first minute with activity to ensure we show relevant data
            // If activity is at minute 45 but we can only show 34 buckets, start from minute 45
            let first_active = buckets.iter().position(|&c| c > 0).unwrap_or(0);
            let start_minute = if first_active + max_buckets <= 60 {
                first_active
            } else {
                60usize.saturating_sub(max_buckets)
            };

            // 2 chars per minute with color gradient based on activity intensity
            for &count in buckets.iter().skip(start_minute).take(max_buckets) {
                let (block, color) = if count == 0 {
                    ("░░", colors.muted)
                } else if count == 1 {
                    ("▓▓", Color::Rgb(100, 180, 100)) // Low - light green
                } else if count <= 3 {
                    ("▓▓", Color::Rgb(50, 205, 50)) // Medium - lime green
                } else if count <= 6 {
                    ("██", Color::Rgb(0, 230, 118)) // High - bright green
                } else {
                    ("██", Color::Rgb(255, 200, 0)) // Very high - gold/yellow
                };
                bucket_spans.push(Span::styled(block, Style::default().fg(color)));
            }

            lines.push(Line::from(bucket_spans));
        }
    }

    lines.push(Line::from(""));

    // === Summary Section ===
    lines.push(Line::from(Span::styled(
        " Summary",
        Style::default()
            .fg(colors.highlight)
            .add_modifier(Modifier::BOLD),
    )));
    lines.push(Line::from(""));

    let total_edits = history.total_edits();
    let file_count = history.file_counts.len();

    lines.push(Line::from(vec![
        Span::styled("   Total edits: ", Style::default().fg(colors.muted)),
        Span::styled(format!("{}", total_edits), Style::default().fg(colors.text)),
    ]));
    lines.push(Line::from(vec![
        Span::styled("   Files touched: ", Style::default().fg(colors.muted)),
        Span::styled(format!("{}", file_count), Style::default().fg(colors.text)),
    ]));

    if let Some(last) = history.last_activity {
        let elapsed = chrono::Utc::now().signed_duration_since(last);
        let elapsed_str = if elapsed.num_hours() > 0 {
            format!("{}h ago", elapsed.num_hours())
        } else if elapsed.num_minutes() > 0 {
            format!("{}m ago", elapsed.num_minutes())
        } else {
            "just now".to_string()
        };
        lines.push(Line::from(vec![
            Span::styled("   Last activity: ", Style::default().fg(colors.muted)),
            Span::styled(elapsed_str, Style::default().fg(colors.text)),
        ]));
    }

    let paragraph = Paragraph::new(lines)
        .wrap(Wrap { trim: false })
        .scroll((scroll, 0));
    frame.render_widget(paragraph, area);
}

/// Smart path compression: middle directories become initials, keep first and last segment
/// Example: `handler/biz/page/get_media_post_count.go` → `h/b/p/get_media_post_count.go`
fn compact_path(path: &str, max_len: usize) -> String {
    if path.chars().count() <= max_len {
        return path.to_string();
    }

    let parts: Vec<&str> = path.split('/').collect();
    if parts.len() <= 2 {
        // Can't compact further, just truncate from start
        if max_len > 3 {
            let skip = path.chars().count() - max_len + 3;
            return format!("...{}", path.chars().skip(skip).collect::<String>());
        }
        return path.to_string();
    }

    // Keep last segment (filename), compress middle directories to initials
    let last = parts[parts.len() - 1];
    let middle: Vec<String> = parts[0..parts.len() - 1]
        .iter()
        .map(|s| s.chars().next().unwrap_or('?').to_string())
        .collect();

    let compact = format!("{}/{}", middle.join("/"), last);
    if compact.chars().count() <= max_len {
        compact
    } else if max_len > 3 {
        // Still too long, truncate from start
        let skip = compact.chars().count() - max_len + 3;
        format!("...{}", compact.chars().skip(skip).collect::<String>())
    } else {
        compact
    }
}

//! Workspace 项目卡片网格组件
//! 卡片风格：左侧首字母渐变方块 + 项目名 + 路径 + 任务数

use std::collections::HashMap;

use ratatui::{
    layout::{Alignment, Rect},
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Paragraph},
    Frame,
};

use crate::hooks::NotificationLevel;
use crate::model::workspace::WorkspaceState;
use crate::model::ProjectInfo;
use crate::theme::ThemeColors;

use super::truncate;

const MIN_CARD_WIDTH: u16 = 32;
const MAX_CARD_WIDTH: u16 = 56;
const CARD_HEIGHT: u16 = 5; // pad + name(block top) + path(initials) + tasks(block bot) + pad
const GAP_X: u16 = 2;
const GAP_Y: u16 = 1;
const PADDING_X: u16 = 2;
const BLOCK_WIDTH: usize = 6;

/// 计算网格列数
fn calculate_grid_cols(area_width: u16) -> usize {
    let usable = area_width.saturating_sub(PADDING_X * 2);
    for cols in [3u16, 2, 1] {
        let needed = cols * MIN_CARD_WIDTH + cols.saturating_sub(1) * GAP_X;
        if usable >= needed {
            return cols as usize;
        }
    }
    1
}

/// 计算卡片宽度
fn calculate_card_width(area_width: u16, cols: usize) -> u16 {
    let usable = area_width.saturating_sub(PADDING_X * 2);
    let cols_u16 = cols as u16;
    let width = (usable.saturating_sub(cols_u16.saturating_sub(1) * GAP_X)) / cols_u16;
    width.min(MAX_CARD_WIDTH)
}

/// 颜色线性插值
fn lerp_color(a: Color, b: Color, t: f32) -> Color {
    match (a, b) {
        (Color::Rgb(r1, g1, b1), Color::Rgb(r2, g2, b2)) => {
            let l = |a: u8, b: u8| (a as f32 + (b as f32 - a as f32) * t.clamp(0.0, 1.0)) as u8;
            Color::Rgb(l(r1, r2), l(g1, g2), l(b1, b2))
        }
        _ => a,
    }
}

/// 生成方块某一行的渐变色 span（左下→右上对角渐变）
///
/// `block_row`: 0=顶, 1=中, 2=底（3 行方块）
fn gradient_block_spans(block_row: usize, color_a: Color, color_b: Color) -> Vec<Span<'static>> {
    let max_t = (BLOCK_WIDTH - 1 + 2) as f32; // width + rows - 1
    (0..BLOCK_WIDTH)
        .map(|col| {
            let t = (col as f32 + (2 - block_row) as f32) / max_t;
            let bg = lerp_color(color_a, color_b, t);
            Span::styled(" ".to_string(), Style::default().bg(bg))
        })
        .collect()
}

/// 缩短路径（HOME → ~）
fn shorten_path(path: &str) -> String {
    if let Ok(home) = std::env::var("HOME") {
        if let Some(rest) = path.strip_prefix(&home) {
            return format!("~{rest}");
        }
    }
    path.to_string()
}

/// 智能压缩路径：中间目录用首字母缩写，保留首段和末段完整
///
/// 例：`~/gobyte/src/code.byted.org/oec/open_solution_seller`
///   → `~/g/s/c/o/open_solution_seller`
/// 仍超长则截断加 `…`
fn compact_path(path: &str, max_len: usize) -> String {
    if path.chars().count() <= max_len {
        return path.to_string();
    }

    let parts: Vec<&str> = path.split('/').collect();
    if parts.len() <= 2 {
        return truncate(path, max_len);
    }

    // 保留第一段（~ 或空）和最后一段，中间缩写为首字母
    let first = parts[0];
    let last = parts[parts.len() - 1];
    let middle: Vec<String> = parts[1..parts.len() - 1]
        .iter()
        .map(|s| s.chars().next().unwrap_or('?').to_string())
        .collect();

    let compact = format!("{}/{}/{}", first, middle.join("/"), last);
    if compact.chars().count() <= max_len {
        compact
    } else {
        truncate(&compact, max_len)
    }
}

/// 渲染项目卡片网格
pub fn render(
    frame: &mut Frame,
    area: Rect,
    workspace: &mut WorkspaceState,
    colors: &ThemeColors,
    workspace_notifications: &HashMap<String, HashMap<String, NotificationLevel>>,
) {
    let project_count = workspace.filtered_indices.len();
    if project_count == 0 {
        return;
    }

    // 计算网格参数
    let cols = calculate_grid_cols(area.width);
    workspace.grid_cols = cols;
    let card_width = calculate_card_width(area.width, cols);
    let total_rows = project_count.div_ceil(cols);
    let visible_rows = ((area.height + GAP_Y) / (CARD_HEIGHT + GAP_Y)) as usize;

    // 确保选中项可见
    workspace.ensure_visible(visible_rows.max(1));
    let scroll = workspace.grid_scroll;
    let selected = workspace.selected_index;

    // 获取 projects 用于渲染
    let projects = workspace.filtered_projects();

    // 计算网格整体宽度并居中
    let cols_u16 = cols as u16;
    let total_grid_width = cols_u16 * card_width + cols_u16.saturating_sub(1) * GAP_X;
    let offset_x = area.x + (area.width.saturating_sub(total_grid_width)) / 2;

    // 标题行
    let title = Line::from(Span::styled(
        "─── Your Projects ───",
        Style::default().fg(colors.muted),
    ));
    let title_area = Rect::new(area.x, area.y, area.width, 1);
    frame.render_widget(
        Paragraph::new(title).alignment(Alignment::Center),
        title_area,
    );

    let grid_start_y = area.y + 2;

    // 渲染可见行的卡片
    for vis_row in 0..visible_rows {
        let row = scroll + vis_row;
        if row >= total_rows {
            break;
        }

        let card_y = grid_start_y + (vis_row as u16) * (CARD_HEIGHT + GAP_Y);
        if card_y + CARD_HEIGHT > area.y + area.height {
            break;
        }

        for col in 0..cols {
            let idx = row * cols + col;
            if idx >= projects.len() {
                break;
            }

            let project = projects[idx];
            let is_selected = selected == Some(idx);
            let card_x = offset_x + (col as u16) * (card_width + GAP_X);

            let card_area = Rect::new(card_x, card_y, card_width, CARD_HEIGHT);
            render_card(
                frame,
                card_area,
                project,
                idx,
                is_selected,
                colors,
                workspace_notifications,
            );
        }
    }
}

/// 渲染单个项目卡片
///
/// 5 行布局，方块跨 3 行，无文字：
/// ```text
///  (上边距)
///  [      ]  project_name              ●
///  [      ]  ~/g/s/c/o/project
///  [      ]  3 tasks               [!!]
///  (下边距)
/// ```
fn render_card(
    frame: &mut Frame,
    area: Rect,
    project: &ProjectInfo,
    index: usize,
    is_selected: bool,
    colors: &ThemeColors,
    workspace_notifications: &HashMap<String, HashMap<String, NotificationLevel>>,
) {
    let card_bg = if is_selected {
        colors.bg_secondary
    } else {
        colors.bg
    };

    frame.render_widget(Block::default().style(Style::default().bg(card_bg)), area);

    if area.width < 12 || area.height < 5 {
        return;
    }

    // 方块渐变色（使用主题调色板）
    let palette = &colors.accent_palette;
    let len = palette.len();
    let color_a = palette[index % len];
    let color_b = palette[(index + 1) % len];

    // 内容可用宽度：左边距 1 + 方块 6 + 间距 2 = 9，右边留 1
    let content_w = (area.width as usize).saturating_sub(10);

    // 状态指示器
    let (status_str, status_color) = if project.live_count > 0 {
        ("●", colors.status_live)
    } else if project.task_count > 0 {
        ("○", colors.muted)
    } else {
        (" ", colors.muted)
    };

    // 通知徽章
    let max_level = workspace_notifications
        .get(&project.name)
        .and_then(|tasks| tasks.values().max());

    let (notif_text, notif_color) = match max_level {
        Some(NotificationLevel::Critical) => (" [!!]", colors.error),
        Some(NotificationLevel::Warn) => (" [!]", colors.warning),
        Some(NotificationLevel::Notice) => (" [i]", colors.info),
        None => ("", colors.muted),
    };

    let pad_line = Line::from(Span::styled(" ", Style::default().bg(card_bg)));

    // ── Row 1: [方块顶]  项目名  ● ──
    let right_len = 2 + notif_text.len();
    let name_max = content_w.saturating_sub(right_len);
    let name = truncate(&project.name, name_max);
    let name_pad = name_max.saturating_sub(name.chars().count());
    let name_color = if is_selected {
        colors.highlight
    } else {
        colors.text
    };

    let mut row1_spans = vec![Span::styled(" ", Style::default().bg(card_bg))];
    row1_spans.extend(gradient_block_spans(0, color_a, color_b));
    row1_spans.push(Span::styled("  ", Style::default().bg(card_bg)));
    row1_spans.push(Span::styled(
        name,
        Style::default()
            .fg(name_color)
            .bg(card_bg)
            .add_modifier(Modifier::BOLD),
    ));
    row1_spans.push(Span::styled(
        " ".repeat(name_pad),
        Style::default().bg(card_bg),
    ));

    if !notif_text.is_empty() {
        row1_spans.push(Span::styled(
            notif_text,
            Style::default().fg(notif_color).bg(card_bg),
        ));
    }

    row1_spans.push(Span::styled(
        format!(" {status_str}"),
        Style::default().fg(status_color).bg(card_bg),
    ));

    let row1 = Line::from(row1_spans);

    // ── Row 2: [方块中]  路径 ──
    let path = shorten_path(&project.path);
    let path_display = compact_path(&path, content_w);

    let mut row2_spans = vec![Span::styled(" ", Style::default().bg(card_bg))];
    row2_spans.extend(gradient_block_spans(1, color_a, color_b));
    row2_spans.push(Span::styled("  ", Style::default().bg(card_bg)));
    row2_spans.push(Span::styled(
        path_display,
        Style::default().fg(colors.muted).bg(card_bg),
    ));
    let row2 = Line::from(row2_spans);

    // ── Row 3: [方块底]  N tasks  [!!] ──
    let task_text = if project.task_count == 1 {
        "1 task".to_string()
    } else {
        format!("{} tasks", project.task_count)
    };

    let mut row3_spans = vec![Span::styled(" ", Style::default().bg(card_bg))];
    row3_spans.extend(gradient_block_spans(2, color_a, color_b));
    row3_spans.push(Span::styled("  ", Style::default().bg(card_bg)));
    row3_spans.push(Span::styled(
        task_text,
        Style::default().fg(colors.muted).bg(card_bg),
    ));

    if !notif_text.is_empty() {
        row3_spans.push(Span::styled(
            notif_text,
            Style::default().fg(notif_color).bg(card_bg),
        ));
    }

    let row3 = Line::from(row3_spans);

    let lines = vec![pad_line.clone(), row1, row2, row3, pad_line];
    let paragraph = Paragraph::new(lines).style(Style::default().bg(card_bg));
    frame.render_widget(paragraph, area);
}

//! 主题选择器组件

use ratatui::{
    layout::{Alignment, Constraint, Layout, Rect},
    style::{Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Clear, Paragraph},
    Frame,
};

use crate::theme::{Theme, ThemeColors};
use crate::ui::click_areas::{ClickAreas, DialogAction};

/// 渲染主题选择器弹窗
pub fn render(
    frame: &mut Frame,
    selected_index: usize,
    colors: &ThemeColors,
    click_areas: &mut ClickAreas,
) {
    let area = frame.area();
    let themes = Theme::all();

    // 计算弹窗尺寸
    let popup_width = 30u16;
    let popup_height = (themes.len() as u16) + 4; // 标题 + 边框 + 内容 + 提示

    // 居中显示
    let popup_x = (area.width.saturating_sub(popup_width)) / 2;
    let popup_y = (area.height.saturating_sub(popup_height)) / 2;

    let popup_area = Rect::new(popup_x, popup_y, popup_width, popup_height);

    // 清除背景
    frame.render_widget(Clear, popup_area);

    // 外框
    let block = Block::default()
        .title(" Theme ")
        .title_alignment(Alignment::Center)
        .borders(Borders::ALL)
        .border_style(Style::default().fg(colors.highlight))
        .style(Style::default().bg(colors.bg));

    let inner_area = block.inner(popup_area);
    frame.render_widget(block, popup_area);

    // 内部布局
    let [list_area, hint_area] = Layout::vertical([
        Constraint::Length(themes.len() as u16),
        Constraint::Length(1),
    ])
    .areas(inner_area);

    // 渲染主题列表
    let lines: Vec<Line> = themes
        .iter()
        .enumerate()
        .map(|(i, theme)| {
            let is_selected = i == selected_index;
            let prefix = if is_selected { "❯ " } else { "  " };

            if is_selected {
                Line::from(Span::styled(
                    format!("{}{}", prefix, theme.label()),
                    Style::default()
                        .fg(colors.highlight)
                        .add_modifier(Modifier::BOLD),
                ))
            } else {
                Line::from(Span::styled(
                    format!("{}{}", prefix, theme.label()),
                    Style::default().fg(colors.text),
                ))
            }
        })
        .collect();

    let list = Paragraph::new(lines).alignment(Alignment::Left);
    frame.render_widget(list, list_area);

    // 渲染底部提示
    let hint = Paragraph::new(Line::from(vec![
        Span::styled("Enter", Style::default().fg(colors.highlight)),
        Span::styled(" select  ", Style::default().fg(colors.muted)),
        Span::styled("Esc", Style::default().fg(colors.highlight)),
        Span::styled(" cancel", Style::default().fg(colors.muted)),
    ]))
    .alignment(Alignment::Center);

    frame.render_widget(hint, hint_area);

    // 注册点击区域
    click_areas.dialog_area = Some(popup_area);
    for (i, _) in themes.iter().enumerate() {
        let row_rect = Rect::new(list_area.x, list_area.y + i as u16, list_area.width, 1);
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

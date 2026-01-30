//! Action Palette 组件（类似 Command Palette）

use ratatui::{
    layout::{Alignment, Constraint, Layout, Rect},
    style::{Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Clear, Paragraph},
    Frame,
};

use crate::theme::ThemeColors;
use crate::ui::click_areas::{ClickAreas, DialogAction};

/// Action 类型
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ActionType {
    Archive,
    Clean,
    RebaseTo,
    Sync,
    Merge,
    Recover,
    Commit,
    Reset,
}

impl ActionType {
    /// Action 名称
    pub fn name(&self) -> &'static str {
        match self {
            ActionType::Archive => "Archive",
            ActionType::Clean => "Clean",
            ActionType::RebaseTo => "Rebase to",
            ActionType::Sync => "Sync",
            ActionType::Merge => "Merge",
            ActionType::Recover => "Recover",
            ActionType::Commit => "Commit",
            ActionType::Reset => "Reset",
        }
    }

    /// Action 描述
    pub fn description(&self) -> &'static str {
        match self {
            ActionType::Archive => "Remove worktree, keep branch",
            ActionType::Clean => "Delete worktree and branch",
            ActionType::RebaseTo => "Change target branch",
            ActionType::Sync => "Sync from target branch",
            ActionType::Merge => "Merge to target branch",
            ActionType::Recover => "Restore worktree from archive",
            ActionType::Commit => "Add all and commit changes",
            ActionType::Reset => "Rebuild branch and worktree",
        }
    }
}

/// Action Palette 数据
#[derive(Debug, Clone)]
pub struct ActionPaletteData {
    /// 可用的 actions
    pub actions: Vec<ActionType>,
    /// 搜索输入
    pub search: String,
    /// 过滤后的 action 索引
    pub filtered_indices: Vec<usize>,
    /// 当前选中索引
    pub selected_index: usize,
}

impl ActionPaletteData {
    pub fn new(actions: Vec<ActionType>) -> Self {
        let filtered_indices: Vec<usize> = (0..actions.len()).collect();
        Self {
            actions,
            search: String::new(),
            filtered_indices,
            selected_index: 0,
        }
    }

    /// 更新搜索过滤
    pub fn update_filter(&mut self) {
        let search_lower = self.search.to_lowercase();
        self.filtered_indices = self
            .actions
            .iter()
            .enumerate()
            .filter(|(_, a)| {
                a.name().to_lowercase().contains(&search_lower)
                    || a.description().to_lowercase().contains(&search_lower)
            })
            .map(|(i, _)| i)
            .collect();

        // 重置选中位置
        if self.selected_index >= self.filtered_indices.len() {
            self.selected_index = 0;
        }
    }

    /// 获取选中的 action
    pub fn selected_action(&self) -> Option<ActionType> {
        self.filtered_indices
            .get(self.selected_index)
            .and_then(|&i| self.actions.get(i))
            .copied()
    }

    /// 向上移动
    pub fn select_prev(&mut self) {
        if !self.filtered_indices.is_empty() {
            if self.selected_index == 0 {
                self.selected_index = self.filtered_indices.len() - 1;
            } else {
                self.selected_index -= 1;
            }
        }
    }

    /// 向下移动
    pub fn select_next(&mut self) {
        if !self.filtered_indices.is_empty() {
            if self.selected_index >= self.filtered_indices.len() - 1 {
                self.selected_index = 0;
            } else {
                self.selected_index += 1;
            }
        }
    }

    /// 添加字符
    pub fn push_char(&mut self, c: char) {
        self.search.push(c);
        self.update_filter();
    }

    /// 删除字符
    pub fn pop_char(&mut self) {
        self.search.pop();
        self.update_filter();
    }
}

/// 弹窗尺寸
const DIALOG_WIDTH: u16 = 50;
const DIALOG_HEIGHT: u16 = 12;

/// 渲染 Action Palette
pub fn render(
    frame: &mut Frame,
    data: &ActionPaletteData,
    colors: &ThemeColors,
    click_areas: &mut ClickAreas,
) {
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
        .title(" Actions ")
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

    // 内部布局
    let [search_area, _spacer, list_area, hint_area] = Layout::vertical([
        Constraint::Length(1), // 搜索框
        Constraint::Length(1), // 间隔
        Constraint::Min(1),    // 列表
        Constraint::Length(1), // 提示
    ])
    .areas(inner_area);

    // 渲染搜索框
    let search_text = format!("> {}", data.search);
    let search = Paragraph::new(Line::from(vec![
        Span::styled(&search_text, Style::default().fg(colors.text)),
        Span::styled("█", Style::default().fg(colors.highlight)),
    ]));
    frame.render_widget(search, search_area);

    // 渲染 action 列表
    let mut lines: Vec<Line> = Vec::new();
    for (display_idx, &real_idx) in data.filtered_indices.iter().enumerate() {
        if let Some(action) = data.actions.get(real_idx) {
            let is_selected = display_idx == data.selected_index;
            let prefix = if is_selected { "❯ " } else { "  " };

            let name_style = if is_selected {
                Style::default()
                    .fg(colors.highlight)
                    .add_modifier(Modifier::BOLD)
            } else {
                Style::default().fg(colors.text)
            };

            let desc_style = Style::default().fg(colors.muted);

            lines.push(Line::from(vec![
                Span::styled(prefix, name_style),
                Span::styled(format!("{:<12}", action.name()), name_style),
                Span::styled(action.description(), desc_style),
            ]));
        }
    }

    // 如果没有匹配项
    if lines.is_empty() {
        lines.push(Line::from(Span::styled(
            "  No matching actions",
            Style::default().fg(colors.muted),
        )));
    }

    let list = Paragraph::new(lines);
    frame.render_widget(list, list_area);

    // 渲染底部提示
    let hint = Paragraph::new(Line::from(vec![
        Span::styled("↑↓", Style::default().fg(colors.highlight)),
        Span::styled(" select  ", Style::default().fg(colors.muted)),
        Span::styled("Enter", Style::default().fg(colors.highlight)),
        Span::styled(" confirm  ", Style::default().fg(colors.muted)),
        Span::styled("Esc", Style::default().fg(colors.highlight)),
        Span::styled(" cancel", Style::default().fg(colors.muted)),
    ]))
    .alignment(Alignment::Center);
    frame.render_widget(hint, hint_area);

    // 注册点击区域
    click_areas.dialog_area = Some(dialog_area);
    for (display_idx, _) in data.filtered_indices.iter().enumerate() {
        let row_rect = Rect::new(
            list_area.x,
            list_area.y + display_idx as u16,
            list_area.width,
            1,
        );
        click_areas.dialog_items.push((row_rect, display_idx));
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

//! Action Palette 组件（类似 Command Palette）

use ratatui::{
    layout::{Alignment, Constraint, Layout, Rect},
    style::{Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Clear, Paragraph},
    Frame,
};

use ratatui::style::Color;

use crate::theme::ThemeColors;
use crate::ui::click_areas::{ClickAreas, DialogAction};

/// Action 分组
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ActionGroup {
    /// 编辑类操作（安全）
    Edit,
    /// 分支操作（普通）
    Branch,
    /// 会话/生命周期操作（危险）
    Session,
}

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
    Review,
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
            ActionType::Review => "Review",
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
            ActionType::Review => "Open diff review in browser",
            ActionType::Reset => "Rebuild branch and worktree",
        }
    }

    /// Action 所属分组
    pub fn group(&self) -> ActionGroup {
        match self {
            ActionType::Commit | ActionType::Review => ActionGroup::Edit,
            ActionType::RebaseTo | ActionType::Sync | ActionType::Merge => ActionGroup::Branch,
            ActionType::Archive | ActionType::Clean | ActionType::Recover | ActionType::Reset => {
                ActionGroup::Session
            }
        }
    }

    /// 选中时的高亮颜色
    fn selected_color(&self, colors: &ThemeColors) -> Color {
        match self.group() {
            ActionGroup::Edit => colors.highlight,
            ActionGroup::Branch => colors.info,
            ActionGroup::Session => colors.error,
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
    /// 滚动偏移（渲染时用于列表窗口定位）
    pub scroll_offset: usize,
    /// 可见行数（渲染时写入，供滚动计算使用）
    pub visible_rows: usize,
}

impl ActionPaletteData {
    pub fn new(actions: Vec<ActionType>) -> Self {
        let filtered_indices: Vec<usize> = (0..actions.len()).collect();
        Self {
            actions,
            search: String::new(),
            filtered_indices,
            selected_index: 0,
            scroll_offset: 0,
            visible_rows: 0,
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

        // 重置选中位置和滚动
        if self.selected_index >= self.filtered_indices.len() {
            self.selected_index = 0;
            self.scroll_offset = 0;
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
            self.ensure_visible();
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
            self.ensure_visible();
        }
    }

    /// 确保选中项在可见窗口内
    fn ensure_visible(&mut self) {
        if self.visible_rows == 0 {
            return;
        }
        if self.selected_index < self.scroll_offset {
            self.scroll_offset = self.selected_index;
        } else if self.selected_index >= self.scroll_offset + self.visible_rows {
            self.scroll_offset = self.selected_index - self.visible_rows + 1;
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

/// 弹窗宽度
const DIALOG_WIDTH: u16 = 50;
/// 边框 + 搜索框 + 间隔 + 提示 = 固定开销
const DIALOG_CHROME: u16 = 2 + 1 + 1 + 1; // borders(2) + search(1) + spacer(1) + hint(1)

/// 渲染 Action Palette
pub fn render(
    frame: &mut Frame,
    data: &mut ActionPaletteData,
    colors: &ThemeColors,
    click_areas: &mut ClickAreas,
) {
    let area = frame.area();

    // 动态高度：适配 action 数量 + 分组间距
    let item_count = data.filtered_indices.len().max(1) as u16;
    // 无搜索时计算分组间空行数
    let group_gaps = if data.search.is_empty() {
        let mut gaps = 0u16;
        let mut last_grp: Option<ActionGroup> = None;
        for &idx in &data.filtered_indices {
            let grp = data.actions[idx].group();
            if last_grp.is_some() && last_grp != Some(grp) {
                gaps += 1; // 分组间空行
            }
            last_grp = Some(grp);
        }
        gaps
    } else {
        0
    };
    let ideal_height = DIALOG_CHROME + item_count + group_gaps;
    let max_height = area.height.saturating_sub(4);
    let dialog_height = ideal_height.clamp(DIALOG_CHROME + 1, max_height);

    // 居中计算
    let x = area.width.saturating_sub(DIALOG_WIDTH) / 2;
    let y = area.height.saturating_sub(dialog_height) / 2;
    let dialog_area = Rect::new(
        x,
        y,
        DIALOG_WIDTH.min(area.width),
        dialog_height.min(area.height),
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

    // 更新可见行数（供 ensure_visible 使用）
    let visible_rows = list_area.height as usize;
    data.visible_rows = visible_rows;
    data.ensure_visible();
    let scroll_offset = data.scroll_offset;

    // 构建显示行：包含分组标题和 action 项
    // display_rows: (Option<display_idx>, Line) — None 表示分组标题行
    let mut display_rows: Vec<(Option<usize>, Line)> = Vec::new();
    let mut last_group: Option<ActionGroup> = None;
    let no_search = data.search.is_empty();

    for (display_idx, &real_idx) in data.filtered_indices.iter().enumerate() {
        if let Some(action) = data.actions.get(real_idx) {
            // 无搜索时才显示分组标题
            if no_search {
                let group = action.group();
                if last_group != Some(group) {
                    // 非首组加空行
                    if last_group.is_some() {
                        display_rows.push((None, Line::from("")));
                    }
                    last_group = Some(group);
                }
            }

            display_rows.push((Some(display_idx), render_action_line(action, false, colors)));
        }
    }

    // 计算滚动：找到选中项在 display_rows 中的位置
    let selected_row_pos = display_rows
        .iter()
        .position(|(idx, _)| *idx == Some(data.selected_index))
        .unwrap_or(0);

    // 调整滚动偏移确保选中行可见
    let total_rows = display_rows.len();
    let mut row_offset = scroll_offset;
    if selected_row_pos < row_offset {
        row_offset = selected_row_pos;
    } else if selected_row_pos >= row_offset + visible_rows {
        row_offset = selected_row_pos.saturating_sub(visible_rows - 1);
    }
    // 不要滚过头
    if total_rows > visible_rows && row_offset > total_rows - visible_rows {
        row_offset = total_rows - visible_rows;
    }

    // 渲染可见行，同时为选中项应用高亮
    let mut lines: Vec<Line> = Vec::new();
    for (idx_opt, line) in display_rows.iter().skip(row_offset).take(visible_rows) {
        if let Some(display_idx) = idx_opt {
            if *display_idx == data.selected_index {
                // 重新渲染选中行
                let real_idx = data.filtered_indices[*display_idx];
                let action = &data.actions[real_idx];
                lines.push(render_action_line(action, true, colors));
            } else {
                lines.push(line.clone());
            }
        } else {
            lines.push(line.clone());
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

    // 注册点击区域（只注册可见的 action 行，跳过分组标题）
    click_areas.dialog_area = Some(dialog_area);
    for (visible_idx, (idx_opt, _)) in display_rows
        .iter()
        .skip(row_offset)
        .take(visible_rows)
        .enumerate()
    {
        if let Some(display_idx) = idx_opt {
            let row_rect = Rect::new(
                list_area.x,
                list_area.y + visible_idx as u16,
                list_area.width,
                1,
            );
            click_areas.dialog_items.push((row_rect, *display_idx));
        }
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

/// 渲染单个 action 行
fn render_action_line<'a>(action: &ActionType, selected: bool, colors: &ThemeColors) -> Line<'a> {
    let prefix = if selected { "❯ " } else { "  " };

    let accent = action.selected_color(colors);
    let name_style = if selected {
        Style::default().fg(accent).add_modifier(Modifier::BOLD)
    } else {
        Style::default().fg(colors.text)
    };
    let desc_style = Style::default().fg(colors.muted);

    Line::from(vec![
        Span::styled(prefix.to_string(), name_style),
        Span::styled(format!("{:<12}", action.name()), name_style),
        Span::styled(action.description().to_string(), desc_style),
    ])
}

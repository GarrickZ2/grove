//! 分支选择器组件（带搜索）

use ratatui::{
    layout::{Alignment, Constraint, Layout, Rect},
    style::{Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Clear, Paragraph},
    Frame,
};

use crate::theme::ThemeColors;

/// 分支选择器模式
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum BranchSelectorMode {
    #[default]
    /// 修改 task 的 target branch
    RebaseTo,
    /// 在主仓库 checkout
    Checkout,
}

/// 分支选择器数据
#[derive(Debug, Clone)]
pub struct BranchSelectorData {
    /// 所有分支
    pub branches: Vec<String>,
    /// 搜索输入
    pub search: String,
    /// 过滤后的分支（索引）
    pub filtered_indices: Vec<usize>,
    /// 当前选中索引（在 filtered_indices 中的位置）
    pub selected_index: usize,
    /// 当前任务名称（RebaseTo 模式）或空（Checkout 模式）
    pub task_name: String,
    /// 当前 target（RebaseTo 模式）或当前分支（Checkout 模式）
    pub current_target: String,
    /// 选择器模式
    pub mode: BranchSelectorMode,
}

impl BranchSelectorData {
    /// 创建 RebaseTo 模式的分支选择器
    pub fn new(branches: Vec<String>, task_name: String, current_target: String) -> Self {
        let filtered_indices: Vec<usize> = (0..branches.len()).collect();
        Self {
            branches,
            search: String::new(),
            filtered_indices,
            selected_index: 0,
            task_name,
            current_target,
            mode: BranchSelectorMode::RebaseTo,
        }
    }

    /// 创建 Checkout 模式的分支选择器
    pub fn new_checkout(branches: Vec<String>, current_branch: String) -> Self {
        let filtered_indices: Vec<usize> = (0..branches.len()).collect();
        Self {
            branches,
            search: String::new(),
            filtered_indices,
            selected_index: 0,
            task_name: String::new(),
            current_target: current_branch,
            mode: BranchSelectorMode::Checkout,
        }
    }

    /// 更新搜索过滤
    pub fn update_filter(&mut self) {
        let search_lower = self.search.to_lowercase();
        self.filtered_indices = self
            .branches
            .iter()
            .enumerate()
            .filter(|(_, b)| b.to_lowercase().contains(&search_lower))
            .map(|(i, _)| i)
            .collect();

        // 重置选中位置
        if self.selected_index >= self.filtered_indices.len() {
            self.selected_index = 0;
        }
    }

    /// 选中的分支
    pub fn selected_branch(&self) -> Option<&str> {
        self.filtered_indices
            .get(self.selected_index)
            .and_then(|&i| self.branches.get(i))
            .map(|s| s.as_str())
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
            self.selected_index = (self.selected_index + 1) % self.filtered_indices.len();
        }
    }

    /// 输入字符
    pub fn input_char(&mut self, c: char) {
        self.search.push(c);
        self.update_filter();
    }

    /// 删除字符
    pub fn delete_char(&mut self) {
        self.search.pop();
        self.update_filter();
    }
}

/// 渲染分支选择器
pub fn render(frame: &mut Frame, data: &BranchSelectorData, colors: &ThemeColors) {
    let area = frame.area();

    // 计算弹窗尺寸
    let popup_width = 50u16;
    let max_visible = 8usize;
    let visible_count = data.filtered_indices.len().min(max_visible).max(1); // 至少1行显示空状态
    let popup_height = (visible_count as u16) + 8; // 标题 + 信息 + 搜索框 + 列表 + 提示

    // 居中显示
    let popup_x = (area.width.saturating_sub(popup_width)) / 2;
    let popup_y = (area.height.saturating_sub(popup_height)) / 2;

    let popup_area = Rect::new(popup_x, popup_y, popup_width, popup_height);

    // 清除背景
    frame.render_widget(Clear, popup_area);

    // 外框（根据模式显示不同标题）
    let title = match data.mode {
        BranchSelectorMode::RebaseTo => " Rebase To ",
        BranchSelectorMode::Checkout => " Checkout ",
    };
    let block = Block::default()
        .title(title)
        .title_alignment(Alignment::Center)
        .borders(Borders::ALL)
        .border_style(Style::default().fg(colors.highlight))
        .style(Style::default().bg(colors.bg));

    let inner_area = block.inner(popup_area);
    frame.render_widget(block, popup_area);

    // 内部布局
    let [info_area, search_area, list_area, hint_area] = Layout::vertical([
        Constraint::Length(2),
        Constraint::Length(3),
        Constraint::Min(1),
        Constraint::Length(1),
    ])
    .areas(inner_area);

    // 渲染信息（根据模式显示不同内容）
    let info_lines = match data.mode {
        BranchSelectorMode::RebaseTo => vec![
            Line::from(vec![
                Span::styled("Task: ", Style::default().fg(colors.muted)),
                Span::styled(&data.task_name, Style::default().fg(colors.text)),
            ]),
            Line::from(vec![
                Span::styled("Current: ", Style::default().fg(colors.muted)),
                Span::styled(&data.current_target, Style::default().fg(colors.highlight)),
            ]),
        ],
        BranchSelectorMode::Checkout => vec![
            Line::from(vec![
                Span::styled("Current branch: ", Style::default().fg(colors.muted)),
                Span::styled(&data.current_target, Style::default().fg(colors.highlight)),
            ]),
            Line::from(Span::styled(
                "Select branch to checkout",
                Style::default().fg(colors.muted),
            )),
        ],
    };
    let info = Paragraph::new(info_lines).alignment(Alignment::Center);
    frame.render_widget(info, info_area);

    // 渲染搜索框
    let search_block = Block::default()
        .title(" Search ")
        .borders(Borders::ALL)
        .border_style(Style::default().fg(colors.border));

    let search_inner = search_block.inner(search_area);
    frame.render_widget(search_block, search_area);

    let search_text = Paragraph::new(Line::from(vec![
        Span::styled(&data.search, Style::default().fg(colors.text)),
        Span::styled(
            "_",
            Style::default()
                .fg(colors.highlight)
                .add_modifier(Modifier::SLOW_BLINK),
        ),
    ]));
    frame.render_widget(search_text, search_inner);

    // 渲染分支列表
    let visible_start = if data.selected_index >= max_visible {
        data.selected_index - max_visible + 1
    } else {
        0
    };

    let lines: Vec<Line> = data
        .filtered_indices
        .iter()
        .enumerate()
        .skip(visible_start)
        .take(max_visible)
        .map(|(i, &branch_idx)| {
            let branch = &data.branches[branch_idx];
            let is_selected = i == data.selected_index;
            let prefix = if is_selected { "❯ " } else { "  " };

            if is_selected {
                Line::from(Span::styled(
                    format!("{}{}", prefix, branch),
                    Style::default()
                        .fg(colors.highlight)
                        .add_modifier(Modifier::BOLD),
                ))
            } else {
                Line::from(Span::styled(
                    format!("{}{}", prefix, branch),
                    Style::default().fg(colors.text),
                ))
            }
        })
        .collect();

    if lines.is_empty() {
        let empty = Paragraph::new(Line::from(Span::styled(
            "No matching branches",
            Style::default().fg(colors.muted),
        )))
        .alignment(Alignment::Center);
        frame.render_widget(empty, list_area);
    } else {
        let list = Paragraph::new(lines);
        frame.render_widget(list, list_area);
    }

    // 渲染底部提示
    let hint = Paragraph::new(Line::from(vec![
        Span::styled("Enter", Style::default().fg(colors.highlight)),
        Span::styled(" select  ", Style::default().fg(colors.muted)),
        Span::styled("Esc", Style::default().fg(colors.highlight)),
        Span::styled(" cancel", Style::default().fg(colors.muted)),
    ]))
    .alignment(Alignment::Center);

    frame.render_widget(hint, hint_area);
}

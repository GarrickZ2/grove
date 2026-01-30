use ratatui::layout::Rect;

use crate::app::PreviewSubTab;
use crate::model::ProjectTab;

/// Dialog 内可点击区域的类型
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DialogAction {
    Confirm,
    Cancel,
}

/// 每帧渲染时缓存的可点击区域
#[derive(Debug, Default, Clone)]
pub struct ClickAreas {
    /// Workspace 卡片 (区域, 过滤后索引)
    pub workspace_cards: Vec<(Rect, usize)>,
    /// Project tabs (区域, tab)
    pub project_tabs: Vec<(Rect, ProjectTab)>,
    /// Worktree 表格行 (区域, 行索引)
    pub worktree_rows: Vec<(Rect, usize)>,
    /// Preview 子 tab (区域, sub_tab)
    pub preview_sub_tabs: Vec<(Rect, PreviewSubTab)>,
    /// Worktree 列表区域（滚轮检测）
    pub worktree_list_area: Option<Rect>,
    /// Preview 内容区域（滚轮检测）
    pub preview_content_area: Option<Rect>,
    /// Workspace 内容区域（滚轮检测）
    pub workspace_content_area: Option<Rect>,
    /// Project 页面 Header 区域（点击返回 Workspace）
    pub project_header_area: Option<Rect>,
    /// Monitor: action 按钮 (区域, action_index)
    pub monitor_actions: Vec<(Rect, usize)>,
    /// Monitor: sidebar 整体区域（点击切换焦点）
    pub monitor_sidebar_area: Option<Rect>,
    /// Monitor: content 整体区域（点击切换焦点）
    pub monitor_content_area: Option<Rect>,
    /// Monitor: tab bar tabs (区域, sub_tab)
    pub monitor_tabs: Vec<(Rect, PreviewSubTab)>,
    /// Dialog 整体区域（判断点击是否在弹窗内）
    pub dialog_area: Option<Rect>,
    /// Dialog 按钮 (区域, action)
    pub dialog_buttons: Vec<(Rect, DialogAction)>,
    /// Dialog 可选项/列表行 (区域, 行索引)
    pub dialog_items: Vec<(Rect, usize)>,
}

impl ClickAreas {
    pub fn reset(&mut self) {
        self.workspace_cards.clear();
        self.project_tabs.clear();
        self.worktree_rows.clear();
        self.preview_sub_tabs.clear();
        self.worktree_list_area = None;
        self.preview_content_area = None;
        self.workspace_content_area = None;
        self.project_header_area = None;
        self.monitor_actions.clear();
        self.monitor_sidebar_area = None;
        self.monitor_content_area = None;
        self.monitor_tabs.clear();
        self.dialog_area = None;
        self.dialog_buttons.clear();
        self.dialog_items.clear();
    }
}

/// 检查坐标 (col, row) 是否在 Rect 内
pub fn contains(rect: &Rect, col: u16, row: u16) -> bool {
    col >= rect.x && col < rect.x + rect.width && row >= rect.y && row < rect.y + rect.height
}

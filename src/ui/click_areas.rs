use ratatui::layout::Rect;

use crate::app::PreviewSubTab;
use crate::model::ProjectTab;

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
    }
}

/// 检查坐标 (col, row) 是否在 Rect 内
pub fn contains(rect: &Rect, col: u16, row: u16) -> bool {
    col >= rect.x
        && col < rect.x + rect.width
        && row >= rect.y
        && row < rect.y + rect.height
}

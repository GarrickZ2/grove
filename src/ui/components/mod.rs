/// 截断字符串到指定最大长度，超出部分用省略号替代
pub fn truncate(s: &str, max_len: usize) -> String {
    if s.chars().count() <= max_len {
        s.to_string()
    } else {
        format!("{}…", s.chars().take(max_len - 1).collect::<String>())
    }
}

pub mod action_palette;
pub mod add_project_dialog;
pub mod branch_selector;
pub mod commit_dialog;
pub mod confirm_dialog;
pub mod delete_project_dialog;
pub mod dialog_utils;
pub mod empty_state;
pub mod footer;
pub mod header;
pub mod help_panel;
pub mod hook_panel;
pub mod input_confirm_dialog;
pub mod logo;
pub mod merge_dialog;
pub mod new_task_dialog;
pub mod preview_panel;
pub mod project_info;
pub mod search_bar;
pub mod tabs;
pub mod theme_selector;
pub mod toast;
pub mod workspace_detail;
pub mod workspace_empty;
pub mod workspace_footer;
pub mod workspace_list;
pub mod worktree_list;

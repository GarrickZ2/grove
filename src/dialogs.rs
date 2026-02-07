//! 对话框状态管理
//!
//! 管理所有 TUI 对话框的显示状态和数据。

// 从 ui/components 导入对话框数据类型
pub use crate::ui::components::action_palette::ActionPaletteData;
pub use crate::ui::components::add_project_dialog::AddProjectData;
pub use crate::ui::components::branch_selector::BranchSelectorData;
pub use crate::ui::components::commit_dialog::CommitDialogData;
pub use crate::ui::components::config_panel::ConfigPanelData;
pub use crate::ui::components::confirm_dialog::ConfirmType;
pub use crate::ui::components::delete_project_dialog::DeleteProjectData;
pub use crate::ui::components::input_confirm_dialog::InputConfirmData;
pub use crate::ui::components::merge_dialog::MergeDialogData;

/// 对话框状态
#[derive(Debug)]
pub struct DialogState {
    // === New Task ===
    /// 是否显示 New Task 弹窗
    pub show_new_task_dialog: bool,
    /// New Task 输入内容
    pub new_task_input: String,

    // === Help ===
    /// 是否显示帮助面板
    pub show_help: bool,

    // === Confirm Dialogs ===
    /// 确认弹窗（弱确认）
    pub confirm_dialog: Option<ConfirmType>,
    /// 输入确认弹窗（强确认）
    pub input_confirm_dialog: Option<InputConfirmData>,

    // === Branch Selector ===
    /// 分支选择器（Rebase To）
    pub branch_selector: Option<BranchSelectorData>,

    // === Merge Dialog ===
    /// Merge 方式选择弹窗
    pub merge_dialog: Option<MergeDialogData>,

    // === Project Dialogs ===
    /// Add Project 弹窗
    pub add_project_dialog: Option<AddProjectData>,
    /// Delete Project 弹窗
    pub delete_project_dialog: Option<DeleteProjectData>,

    // === Action Palette ===
    /// Action Palette
    pub action_palette: Option<ActionPaletteData>,

    // === Commit Dialog ===
    /// Commit 弹窗
    pub commit_dialog: Option<CommitDialogData>,

    // === Config Panel ===
    /// Config 配置面板
    pub config_panel: Option<ConfigPanelData>,
}

impl Default for DialogState {
    fn default() -> Self {
        Self::new()
    }
}

impl DialogState {
    /// 创建新的对话框状态
    pub fn new() -> Self {
        Self {
            show_new_task_dialog: false,
            new_task_input: String::new(),
            show_help: false,
            confirm_dialog: None,
            input_confirm_dialog: None,
            branch_selector: None,
            merge_dialog: None,
            add_project_dialog: None,
            delete_project_dialog: None,
            action_palette: None,
            commit_dialog: None,
            config_panel: None,
        }
    }

    /// 关闭所有对话框
    #[allow(dead_code)]
    pub fn close_all(&mut self) {
        self.show_new_task_dialog = false;
        self.new_task_input.clear();
        self.show_help = false;
        self.confirm_dialog = None;
        self.input_confirm_dialog = None;
        self.branch_selector = None;
        self.merge_dialog = None;
        self.add_project_dialog = None;
        self.delete_project_dialog = None;
        self.action_palette = None;
        self.commit_dialog = None;
        self.config_panel = None;
    }

    /// 检查是否有活跃的对话框
    #[allow(dead_code)]
    pub fn has_active_dialog(&self) -> bool {
        self.show_new_task_dialog
            || self.show_help
            || self.confirm_dialog.is_some()
            || self.input_confirm_dialog.is_some()
            || self.branch_selector.is_some()
            || self.merge_dialog.is_some()
            || self.add_project_dialog.is_some()
            || self.delete_project_dialog.is_some()
            || self.action_palette.is_some()
            || self.commit_dialog.is_some()
            || self.config_panel.is_some()
    }

    /// 检查是否有需要用户输入的对话框
    #[allow(dead_code)]
    pub fn has_input_dialog(&self) -> bool {
        self.show_new_task_dialog
            || self.input_confirm_dialog.is_some()
            || self.add_project_dialog.is_some()
            || self.action_palette.is_some()
            || self.commit_dialog.is_some()
    }
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_new_creates_empty_state() {
        let state = DialogState::new();
        assert!(!state.show_new_task_dialog);
        assert!(!state.show_help);
        assert!(state.confirm_dialog.is_none());
        assert!(state.new_task_input.is_empty());
    }

    #[test]
    fn test_close_all_clears_all_dialogs() {
        let mut state = DialogState::new();

        // 打开各种对话框
        state.show_new_task_dialog = true;
        state.new_task_input = "test".to_string();
        state.show_help = true;
        state.confirm_dialog = Some(ConfirmType::ArchiveUnmerged {
            task_name: "Test Task".to_string(),
            branch: "test-branch".to_string(),
        });
        state.input_confirm_dialog = Some(InputConfirmData::new(
            "Test Task".to_string(),
            "test-branch".to_string(),
        ));

        // 关闭所有
        state.close_all();

        // 验证所有对话框都关闭了
        assert!(!state.show_new_task_dialog);
        assert!(state.new_task_input.is_empty());
        assert!(!state.show_help);
        assert!(state.confirm_dialog.is_none());
        assert!(state.input_confirm_dialog.is_none());
        assert!(state.branch_selector.is_none());
        assert!(state.merge_dialog.is_none());
        assert!(state.add_project_dialog.is_none());
        assert!(state.delete_project_dialog.is_none());
        assert!(state.action_palette.is_none());
        assert!(state.commit_dialog.is_none());
        assert!(state.config_panel.is_none());
    }

    #[test]
    fn test_has_active_dialog_with_new_task() {
        let mut state = DialogState::new();
        assert!(!state.has_active_dialog());

        state.show_new_task_dialog = true;
        assert!(state.has_active_dialog());
    }

    #[test]
    fn test_has_active_dialog_with_confirm() {
        let mut state = DialogState::new();
        assert!(!state.has_active_dialog());

        state.confirm_dialog = Some(ConfirmType::ArchiveUnmerged {
            task_name: "Test".to_string(),
            branch: "test".to_string(),
        });
        assert!(state.has_active_dialog());
    }

    #[test]
    fn test_has_active_dialog_after_close_all() {
        let mut state = DialogState::new();
        state.show_new_task_dialog = true;
        state.confirm_dialog = Some(ConfirmType::CleanMerged {
            task_name: "Test".to_string(),
            branch: "test".to_string(),
        });

        assert!(state.has_active_dialog());

        state.close_all();
        assert!(!state.has_active_dialog());
    }

    #[test]
    fn test_has_input_dialog() {
        let mut state = DialogState::new();
        assert!(!state.has_input_dialog());

        state.show_new_task_dialog = true;
        assert!(state.has_input_dialog());

        state.show_new_task_dialog = false;
        state.show_help = true; // Help 不需要输入
        assert!(!state.has_input_dialog());

        state.input_confirm_dialog = Some(InputConfirmData::new(
            "Test".to_string(),
            "test-branch".to_string(),
        ));
        assert!(state.has_input_dialog());
    }
}

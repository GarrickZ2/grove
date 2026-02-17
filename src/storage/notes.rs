use super::ensure_task_data_dir;
use crate::error::Result;

/// 获取 notes 文件完整路径（字符串）
pub fn notes_file_path(project: &str, task_id: &str) -> Result<String> {
    let path = ensure_task_data_dir(project, task_id)?.join("notes.md");
    Ok(path.to_string_lossy().to_string())
}

/// 如果 notes 文件不存在则创建空文件
pub fn save_notes_if_not_exists(project: &str, task_id: &str) -> Result<()> {
    let path = ensure_task_data_dir(project, task_id)?.join("notes.md");
    if !path.exists() {
        std::fs::write(&path, "")?;
    }
    Ok(())
}

/// 读取用户笔记
pub fn load_notes(project: &str, task_id: &str) -> Result<String> {
    let path = ensure_task_data_dir(project, task_id)?.join("notes.md");
    if path.exists() {
        let content = std::fs::read_to_string(&path)?;
        Ok(content)
    } else {
        Ok(String::new())
    }
}

/// 保存用户笔记
pub fn save_notes(project: &str, task_id: &str, content: &str) -> Result<()> {
    let path = ensure_task_data_dir(project, task_id)?.join("notes.md");
    std::fs::write(&path, content)?;
    Ok(())
}

use std::io;
use std::path::PathBuf;

use super::ensure_project_dir;

/// 获取 notes 目录路径
fn notes_dir(project: &str) -> io::Result<PathBuf> {
    let dir = ensure_project_dir(project)?.join("notes");
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

/// 获取 notes 文件完整路径（字符串）
pub fn notes_file_path(project: &str, task_id: &str) -> io::Result<String> {
    let path = notes_dir(project)?.join(format!("{}.md", task_id));
    Ok(path.to_string_lossy().to_string())
}

/// 如果 notes 文件不存在则创建空文件
pub fn save_notes_if_not_exists(project: &str, task_id: &str) -> io::Result<()> {
    let path = notes_dir(project)?.join(format!("{}.md", task_id));
    if !path.exists() {
        std::fs::write(&path, "")?;
    }
    Ok(())
}

/// 读取用户笔记
pub fn load_notes(project: &str, task_id: &str) -> io::Result<String> {
    let path = notes_dir(project)?.join(format!("{}.md", task_id));
    if path.exists() {
        std::fs::read_to_string(&path)
    } else {
        Ok(String::new())
    }
}

/// 保存用户笔记
pub fn save_notes(project: &str, task_id: &str, content: &str) -> io::Result<()> {
    let path = notes_dir(project)?.join(format!("{}.md", task_id));
    std::fs::write(&path, content)
}

/// 删除用户笔记
pub fn delete_notes(project: &str, task_id: &str) -> io::Result<()> {
    let path = notes_dir(project)?.join(format!("{}.md", task_id));
    if path.exists() {
        std::fs::remove_file(&path)?;
    }
    Ok(())
}

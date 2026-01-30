use std::io;

use super::ensure_project_dir;

/// 获取 diff comments 存储路径: ~/.grove/projects/{project}/ai/{task_id}/diff_comments.md
fn diff_comments_path(project: &str, task_id: &str) -> io::Result<std::path::PathBuf> {
    let dir = ensure_project_dir(project)?.join("ai").join(task_id);
    std::fs::create_dir_all(&dir)?;
    Ok(dir.join("diff_comments.md"))
}

/// 读取 diff review comments
pub fn load_diff_comments(project: &str, task_id: &str) -> io::Result<String> {
    let path = diff_comments_path(project, task_id)?;
    if path.exists() {
        std::fs::read_to_string(&path)
    } else {
        Ok(String::new())
    }
}

/// 保存 diff review comments
pub fn save_diff_comments(project: &str, task_id: &str, content: &str) -> io::Result<()> {
    let path = diff_comments_path(project, task_id)?;
    std::fs::write(&path, content)
}

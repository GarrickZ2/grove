use std::path::Path;
use std::process::Command;

/// 创建 git worktree
/// 执行: git worktree add -b {branch} {path} {base}
pub fn create_worktree(
    repo_path: &str,
    branch: &str,
    worktree_path: &Path,
    base_branch: &str,
) -> Result<(), String> {
    let output = Command::new("git")
        .current_dir(repo_path)
        .args([
            "worktree",
            "add",
            "-b",
            branch,
            worktree_path.to_str().unwrap_or_default(),
            base_branch,
        ])
        .output()
        .map_err(|e| format!("Failed to execute git: {}", e))?;

    if output.status.success() {
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(format!("git worktree add failed: {}", stderr.trim()))
    }
}

/// 获取当前分支名
/// 执行: git rev-parse --abbrev-ref HEAD
pub fn current_branch(repo_path: &str) -> Result<String, String> {
    let output = Command::new("git")
        .current_dir(repo_path)
        .args(["rev-parse", "--abbrev-ref", "HEAD"])
        .output()
        .map_err(|e| format!("Failed to execute git: {}", e))?;

    if output.status.success() {
        let branch = String::from_utf8_lossy(&output.stdout);
        Ok(branch.trim().to_string())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(format!("git rev-parse failed: {}", stderr.trim()))
    }
}

/// 获取仓库根目录
/// 执行: git rev-parse --show-toplevel
pub fn repo_root(path: &str) -> Result<String, String> {
    let output = Command::new("git")
        .current_dir(path)
        .args(["rev-parse", "--show-toplevel"])
        .output()
        .map_err(|e| format!("Failed to execute git: {}", e))?;

    if output.status.success() {
        let root = String::from_utf8_lossy(&output.stdout);
        Ok(root.trim().to_string())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(format!("git rev-parse failed: {}", stderr.trim()))
    }
}

/// 检查是否在 git 仓库中
pub fn is_git_repo(path: &str) -> bool {
    Command::new("git")
        .current_dir(path)
        .args(["rev-parse", "--git-dir"])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

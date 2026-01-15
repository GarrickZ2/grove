use std::process::Command;

/// 生成 tmux session 名称
/// 格式: grove-{project}-{task_slug}
pub fn session_name(project: &str, task_slug: &str) -> String {
    format!("grove-{}-{}", project, task_slug)
}

/// 创建 tmux session (后台)
/// 执行: tmux new-session -d -s {name} -c {path}
pub fn create_session(name: &str, working_dir: &str) -> Result<(), String> {
    let output = Command::new("tmux")
        .args(["new-session", "-d", "-s", name, "-c", working_dir])
        .output()
        .map_err(|e| format!("Failed to execute tmux: {}", e))?;

    if output.status.success() {
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        // 如果 session 已存在，不算错误
        if stderr.contains("duplicate session") {
            Ok(())
        } else {
            Err(format!("tmux new-session failed: {}", stderr.trim()))
        }
    }
}

/// attach 到 tmux session (阻塞)
/// 执行: tmux attach-session -t {name}
/// 注意: 这个函数应该在 TUI 退出后调用
pub fn attach_session(name: &str) -> Result<(), String> {
    let status = Command::new("tmux")
        .args(["attach-session", "-t", name])
        .status()
        .map_err(|e| format!("Failed to execute tmux: {}", e))?;

    if status.success() {
        Ok(())
    } else {
        Err("tmux attach-session failed".to_string())
    }
}

/// 检查 session 是否存在
pub fn session_exists(name: &str) -> bool {
    Command::new("tmux")
        .args(["has-session", "-t", name])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// 检查 tmux 是否可用
pub fn is_available() -> bool {
    Command::new("tmux")
        .arg("-V")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// 关闭 tmux session
/// 执行: tmux kill-session -t {name}
pub fn kill_session(name: &str) -> Result<(), String> {
    let output = Command::new("tmux")
        .args(["kill-session", "-t", name])
        .output()
        .map_err(|e| format!("Failed to execute tmux: {}", e))?;

    if output.status.success() {
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        // session 不存在也不算错误
        if stderr.contains("no server running") || stderr.contains("session not found") {
            Ok(())
        } else {
            Err(format!("tmux kill-session failed: {}", stderr.trim()))
        }
    }
}

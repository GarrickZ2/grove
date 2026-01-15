use std::process::Command;

/// 生成 session 名称
/// 格式: grove-{project}-{task_slug}
pub fn session_name(project: &str, task_slug: &str) -> String {
    format!("grove-{}-{}", project, task_slug)
}

/// Session 环境变量
#[derive(Debug, Clone, Default)]
pub struct SessionEnv {
    /// Task ID (slug)
    pub task_id: String,
    /// Task 名称 (人类可读)
    pub task_name: String,
    /// 当前分支
    pub branch: String,
    /// 目标分支
    pub target: String,
    /// Worktree 路径
    pub worktree: String,
    /// 项目名称
    pub project_name: String,
    /// 主仓库路径
    pub project_path: String,
}

/// 创建 session (后台)
/// 执行: tmux new-session -d -s {name} -c {path} -e VAR=value ...
pub fn create_session(name: &str, working_dir: &str, env: Option<&SessionEnv>) -> Result<(), String> {
    let mut args = vec![
        "new-session".to_string(),
        "-d".to_string(),
        "-s".to_string(),
        name.to_string(),
        "-c".to_string(),
        working_dir.to_string(),
    ];

    // 注入环境变量 (tmux 3.0+)
    if let Some(env) = env {
        args.push("-e".to_string());
        args.push(format!("GROVE_TASK_ID={}", env.task_id));
        args.push("-e".to_string());
        args.push(format!("GROVE_TASK_NAME={}", env.task_name));
        args.push("-e".to_string());
        args.push(format!("GROVE_BRANCH={}", env.branch));
        args.push("-e".to_string());
        args.push(format!("GROVE_TARGET={}", env.target));
        args.push("-e".to_string());
        args.push(format!("GROVE_WORKTREE={}", env.worktree));
        args.push("-e".to_string());
        args.push(format!("GROVE_PROJECT_NAME={}", env.project_name));
        args.push("-e".to_string());
        args.push(format!("GROVE_PROJECT={}", env.project_path));
    }

    let output = Command::new("tmux")
        .args(&args)
        .output()
        .map_err(|e| format!("Session create failed: {}", e))?;

    if output.status.success() {
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        // 如果 session 已存在，不算错误
        if stderr.contains("duplicate session") {
            Ok(())
        } else {
            Err(format!("Session create failed: {}", stderr.trim()))
        }
    }
}

/// attach 到 session (阻塞)
/// 执行: tmux attach-session -t {name}
/// 注意: 这个函数应该在 TUI 退出后调用
pub fn attach_session(name: &str) -> Result<(), String> {
    let status = Command::new("tmux")
        .args(["attach-session", "-t", name])
        .status()
        .map_err(|e| format!("Session attach failed: {}", e))?;

    if status.success() {
        Ok(())
    } else {
        Err("Session attach failed".to_string())
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

/// 关闭 session
/// 执行: tmux kill-session -t {name}
pub fn kill_session(name: &str) -> Result<(), String> {
    let output = Command::new("tmux")
        .args(["kill-session", "-t", name])
        .output()
        .map_err(|e| format!("Session close failed: {}", e))?;

    if output.status.success() {
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        // session 不存在也不算错误
        if stderr.contains("no server running") || stderr.contains("session not found") {
            Ok(())
        } else {
            Err(format!("Session close failed: {}", stderr.trim()))
        }
    }
}

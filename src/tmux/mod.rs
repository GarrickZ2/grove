pub mod layout;

use std::collections::HashMap;
use std::process::Command;

use crate::error::{GroveError, Result};

/// Deterministic, tmux-safe session name for a chat's agent terminal.
///
/// tmux uses `.` and `:` as target separators (`session:window.pane`), so a
/// name containing either becomes unaddressable. Chat ids today are
/// `chat-<hex>` (already safe), but we sanitise defensively so a future id
/// scheme can never produce a session we can't `attach`/`has-session`/`kill`.
pub fn agent_session_name(chat_id: &str) -> String {
    let sanitized: String = chat_id
        .chars()
        .map(|c| {
            if c == '.' || c == ':' || c.is_whitespace() {
                '-'
            } else {
                c
            }
        })
        .collect();
    format!("grove-agent-{}", sanitized)
}

/// Create a detached tmux session that runs a specific command, injecting the
/// given environment and working directory. Idempotent: if the session already
/// exists this is a no-op success (the caller should attach to it).
///
/// Executes: `tmux new-session -d -s {name} -c {cwd} -e K=V ... -- cmd args...`
///
/// `-e` (per-session environment) requires tmux 3.2+, matching the requirement
/// `create_session` already imposes. The `--` terminates tmux option parsing so
/// dash-prefixed command args (e.g. `--resume <uuid>`, `npx -y`) reach the
/// command instead of being read as tmux flags. The command is executed
/// directly (no intermediate shell), so no quoting of `command` entries is
/// needed. Env values are emitted in sorted-key order for a stable command line
/// (deterministic tests, predictable `ps` output).
pub fn create_command_session(
    name: &str,
    working_dir: &str,
    env: &HashMap<String, String>,
    command: &[String],
) -> Result<()> {
    if command.is_empty() {
        return Err(GroveError::session("create_command_session: empty command"));
    }

    let mut args: Vec<String> = vec![
        "new-session".to_string(),
        "-d".to_string(),
        "-s".to_string(),
        name.to_string(),
        "-c".to_string(),
        working_dir.to_string(),
    ];

    let mut keys: Vec<&String> = env.keys().collect();
    keys.sort();
    for k in keys {
        args.push("-e".to_string());
        args.push(format!("{}={}", k, env[k]));
    }

    args.push("--".to_string());
    args.extend(command.iter().cloned());

    let output = Command::new("tmux")
        .args(&args)
        .output()
        .map_err(|e| GroveError::session(format!("Agent session create failed: {}", e)))?;

    if output.status.success() {
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        // A concurrent attach may have created it first — not an error.
        if stderr.contains("duplicate session") {
            Ok(())
        } else {
            Err(GroveError::session(format!(
                "Agent session create failed: {}",
                stderr.trim()
            )))
        }
    }
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

impl SessionEnv {
    /// 将环境变量添加到 Command (通用方法)
    pub fn apply_to_command(&self, cmd: &mut Command) {
        cmd.env("GROVE_TASK_ID", &self.task_id);
        cmd.env("GROVE_TASK_NAME", &self.task_name);
        cmd.env("GROVE_BRANCH", &self.branch);
        cmd.env("GROVE_TARGET", &self.target);
        cmd.env("GROVE_WORKTREE", &self.worktree);
        cmd.env("GROVE_PROJECT_NAME", &self.project_name);
        cmd.env("GROVE_PROJECT", &self.project_path);
    }

    /// 生成 shell export 前缀，用于在 zellij KDL layout 中注入环境变量
    ///
    /// 返回格式: `export GROVE_TASK_ID='val' GROVE_BRANCH='val' ...; `
    pub fn shell_export_prefix(&self) -> String {
        let vars = [
            ("GROVE_TASK_ID", &self.task_id),
            ("GROVE_TASK_NAME", &self.task_name),
            ("GROVE_BRANCH", &self.branch),
            ("GROVE_TARGET", &self.target),
            ("GROVE_WORKTREE", &self.worktree),
            ("GROVE_PROJECT_NAME", &self.project_name),
            ("GROVE_PROJECT", &self.project_path),
        ];
        let parts: Vec<String> = vars
            .iter()
            .map(|(k, v)| format!("{}='{}'", k, v.replace('\'', "'\\''")))
            .collect();
        format!("export {}; ", parts.join(" "))
    }
}

/// 创建 session (后台)
/// 执行: tmux new-session -d -s {name} -c {path} -e VAR=value ...
pub fn create_session(name: &str, working_dir: &str, env: Option<&SessionEnv>) -> Result<()> {
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
        .map_err(|e| GroveError::session(format!("Session create failed: {}", e)))?;

    if output.status.success() {
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        // 如果 session 已存在，不算错误
        if stderr.contains("duplicate session") {
            Ok(())
        } else {
            Err(GroveError::session(format!(
                "Session create failed: {}",
                stderr.trim()
            )))
        }
    }
}

/// attach 到 session (阻塞)
/// 执行: tmux attach-session -t {name}
/// 注意: 这个函数应该在 TUI 退出后调用
pub fn attach_session(name: &str) -> Result<()> {
    let status = Command::new("tmux")
        .args(["attach-session", "-t", name])
        .status()
        .map_err(|e| GroveError::session(format!("Session attach failed: {}", e)))?;

    if status.success() {
        Ok(())
    } else {
        Err(GroveError::session("Session attach failed"))
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
pub fn kill_session(name: &str) -> Result<()> {
    let output = Command::new("tmux")
        .args(["kill-session", "-t", name])
        .output()
        .map_err(|e| GroveError::session(format!("Session close failed: {}", e)))?;

    if output.status.success() {
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        // session 不存在也不算错误
        if stderr.contains("no server running") || stderr.contains("session not found") {
            Ok(())
        } else {
            Err(GroveError::session(format!(
                "Session close failed: {}",
                stderr.trim()
            )))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn agent_session_name_is_stable_for_normal_chat_ids() {
        assert_eq!(
            agent_session_name("chat-5f065266e8cb432c857901a4ce84ee25"),
            "grove-agent-chat-5f065266e8cb432c857901a4ce84ee25"
        );
    }

    #[test]
    fn agent_session_name_neutralises_tmux_separators() {
        // '.' and ':' would break `attach -t name`; whitespace breaks argv.
        let n = agent_session_name("a.b:c d");
        assert_eq!(n, "grove-agent-a-b-c-d");
        assert!(!n.contains('.') && !n.contains(':') && !n.contains(' '));
    }

    #[test]
    fn create_command_session_rejects_empty_command() {
        let env = HashMap::new();
        assert!(create_command_session("grove-agent-x", "/tmp", &env, &[]).is_err());
    }
}

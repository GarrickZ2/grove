pub mod layout;

use std::process::Command;

use crate::error::{GroveError, Result};
use crate::tmux::SessionEnv;

/// 创建 zellij Command 并移除 ZELLIJ 环境变量（防止嵌套 session 干扰）
fn zellij_cmd() -> Command {
    let mut cmd = Command::new("zellij");
    cmd.env_remove("ZELLIJ");
    cmd.env_remove("ZELLIJ_SESSION_NAME");
    cmd
}

/// 去除 ANSI 转义序列（list-sessions 带颜色输出时需要）
fn strip_ansi(s: &str) -> String {
    let mut result = String::new();
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\x1b' {
            while let Some(&nc) = chars.peek() {
                chars.next();
                if nc.is_ascii_alphabetic() {
                    break;
                }
            }
        } else {
            result.push(c);
        }
    }
    result
}

/// 创建 session (no-op: zellij 不支持 detached 创建)
pub fn create_session(_name: &str, _working_dir: &str, _env: Option<&SessionEnv>) -> Result<()> {
    Ok(())
}

/// 检查 session 是否活跃（排除 EXITED）
pub fn session_exists(name: &str) -> bool {
    let output = match zellij_cmd().args(["list-sessions"]).output() {
        Ok(o) if o.status.success() => o,
        _ => return false,
    };

    let stdout = String::from_utf8_lossy(&output.stdout);
    stdout.lines().any(|line| {
        if line.contains("EXITED") {
            return false;
        }
        let clean = strip_ansi(line);
        clean.split_whitespace().next() == Some(name)
    })
}

/// 关闭活跃 session
pub fn kill_session(name: &str) -> Result<()> {
    let output = zellij_cmd()
        .args(["kill-session", name])
        .output()
        .map_err(|e| GroveError::session(format!("Zellij kill-session failed: {}", e)))?;

    if output.status.success() {
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        if stderr.contains("not found")
            || stderr.contains("No session")
            || stderr.contains("no server")
        {
            Ok(())
        } else {
            Err(GroveError::session(format!(
                "Zellij kill-session failed: {}",
                stderr.trim()
            )))
        }
    }
}

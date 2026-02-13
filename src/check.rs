//! 环境检查

use std::process::Command;

pub struct CheckResult {
    pub ok: bool,
    pub errors: Vec<String>,
}

pub fn check_environment() -> CheckResult {
    let mut errors = Vec::new();

    // 检查 git
    if !check_git() {
        errors.push("git is not installed. Please install git first.".to_string());
    }

    // 检查 tmux 和 zellij — 不强制要求，只检查版本
    // 用户可以在 Settings 页面查看状态并安装
    let tmux_ok = check_tmux_available();

    // 如果 tmux 可用但版本太旧，给出警告（非致命）
    if tmux_ok {
        if let TmuxCheck::VersionTooOld(ver) = check_tmux() {
            errors.push(format!(
                "tmux version {} is too old. Please upgrade to tmux 3.0+ for tmux support.",
                ver
            ));
        }
    }

    CheckResult {
        ok: errors.is_empty(),
        errors,
    }
}

fn check_git() -> bool {
    Command::new("git")
        .arg("--version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// Check if fzf is installed (for grove fp command)
pub fn check_fzf() -> bool {
    Command::new("fzf")
        .arg("--version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// Check if tmux is installed (any version)
pub fn check_tmux_available() -> bool {
    // 测试模式：通过环境变量模拟 tmux 不存在
    // 使用方法: GROVE_TEST_NO_TMUX=1 cargo run
    if std::env::var("GROVE_TEST_NO_TMUX").is_ok() {
        return false;
    }

    Command::new("tmux")
        .arg("-V")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// Check if zellij is installed
pub fn check_zellij_available() -> bool {
    // 测试模式：通过环境变量模拟 zellij 不存在
    // 使用方法: GROVE_TEST_NO_ZELLIJ=1 cargo run
    if std::env::var("GROVE_TEST_NO_ZELLIJ").is_ok() {
        return false;
    }

    Command::new("zellij")
        .arg("--version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

enum TmuxCheck {
    Ok,
    NotInstalled,
    VersionTooOld(String),
}

fn check_tmux() -> TmuxCheck {
    let output = match Command::new("tmux").arg("-V").output() {
        Ok(o) if o.status.success() => o,
        _ => return TmuxCheck::NotInstalled,
    };

    let version_str = String::from_utf8_lossy(&output.stdout);
    // "tmux 3.4" -> parse "3.4"
    let version = version_str
        .trim()
        .strip_prefix("tmux ")
        .unwrap_or("")
        .split(|c: char| !c.is_ascii_digit() && c != '.')
        .next()
        .unwrap_or("");

    let major: u32 = version
        .split('.')
        .next()
        .and_then(|s| s.parse().ok())
        .unwrap_or(0);

    if major >= 3 {
        TmuxCheck::Ok
    } else {
        TmuxCheck::VersionTooOld(version.to_string())
    }
}

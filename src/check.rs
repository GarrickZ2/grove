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

    // 检查 npx
    if !check_npx() {
        errors.push(
            "npx is not installed. Please install Node.js (which includes npx) first.".to_string(),
        );
    }

    // 检查 tmux
    match check_tmux() {
        TmuxCheck::NotInstalled => {
            errors.push("tmux is not installed. Please install tmux 3.0+ first.".to_string());
        }
        TmuxCheck::VersionTooOld(ver) => {
            errors.push(format!(
                "tmux version {} is too old. Please upgrade to tmux 3.0+.",
                ver
            ));
        }
        TmuxCheck::Ok => {}
    }

    CheckResult {
        ok: errors.is_empty(),
        errors,
    }
}

fn check_npx() -> bool {
    Command::new("npx")
        .arg("--version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

fn check_git() -> bool {
    Command::new("git")
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

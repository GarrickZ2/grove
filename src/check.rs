//! 环境检查

use std::path::Path;
use std::process::Command;

/// Check if a command exists on PATH (cross-platform, in-process — no subprocess spawn).
///
/// Walks `PATH` directly and respects `PATHEXT` on Windows. Avoids spawning
/// `which` / `where.exe` per check (Windows process creation is slow, and
/// `where.exe` writes noise to stderr when not found).
pub fn command_exists(cmd: &str) -> bool {
    let path_var = match std::env::var_os("PATH") {
        Some(v) => v,
        None => return false,
    };

    #[cfg(windows)]
    let exts: Vec<String> = std::env::var("PATHEXT")
        .unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".to_string())
        .split(';')
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .collect();
    #[cfg(not(windows))]
    let exts: Vec<String> = vec![String::new()];

    // On Windows, only accept a literal name with extension if that extension
    // is in PATHEXT — otherwise `command_exists("foo.txt")` would falsely match a
    // text file in PATH. On Unix, any literal name is fine.
    #[cfg(windows)]
    let literal_ok = Path::new(cmd)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| {
            let dot_e = format!(".{}", e);
            exts.iter().any(|p| p.eq_ignore_ascii_case(&dot_e))
        })
        .unwrap_or(false);
    #[cfg(not(windows))]
    let literal_ok = true;

    for dir in std::env::split_paths(&path_var) {
        if literal_ok {
            let candidate = dir.join(cmd);
            if is_executable_file(&candidate) {
                return true;
            }
        }
        #[cfg(windows)]
        {
            for ext in &exts {
                let candidate = dir.join(format!("{}{}", cmd, ext));
                if is_executable_file(&candidate) {
                    return true;
                }
            }
        }
        #[cfg(not(windows))]
        {
            // exts is [""] on Unix; literal_ok branch above already covered it.
            let _ = &exts;
        }
    }
    false
}

/// On Unix, also requires at least one execute bit. On Windows, PATHEXT entries
/// are considered executable by virtue of their extension — `is_file()` is enough.
fn is_executable_file(path: &Path) -> bool {
    let meta = match std::fs::metadata(path) {
        Ok(m) => m,
        Err(_) => return false,
    };
    if !meta.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        meta.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}

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

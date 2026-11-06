//! 环境检查

use std::path::{Path, PathBuf};
use std::process::Command;

/// Resolve a command name to an absolute executable path on PATH.
///
/// Walks `PATH` directly and respects `PATHEXT` on Windows. Returns the first
/// matching path, or `None` if nothing on PATH is executable. Avoids spawning
/// `which` / `where.exe` per check (Windows process creation is slow, and
/// `where.exe` writes noise to stderr when not found).
///
/// On Windows this is what callers should use *before* `Command::new(...)` for
/// any program that may be installed as a shim (`.cmd`/`.bat`, e.g. npm-global
/// CLIs). `CreateProcessW` does NOT search PATHEXT — passing a bare `"opencode"`
/// will fail even if `opencode.cmd` is on PATH.
pub fn resolve_program(cmd: &str) -> Option<PathBuf> {
    // If the caller already gave us an absolute or path-qualified name, just
    // verify it's executable and return as-is. Don't try to re-search PATH.
    if Path::new(cmd).components().count() > 1 {
        return is_executable_file(Path::new(cmd)).then(|| PathBuf::from(cmd));
    }

    let path_var = std::env::var_os("PATH")?;

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
    // is in PATHEXT — otherwise `resolve_program("foo.txt")` would falsely match
    // a text file in PATH. On Unix, any literal name is fine.
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
                return Some(candidate);
            }
        }
        #[cfg(windows)]
        {
            for ext in &exts {
                let candidate = dir.join(format!("{}{}", cmd, ext));
                if is_executable_file(&candidate) {
                    return Some(candidate);
                }
            }
        }
        #[cfg(not(windows))]
        {
            // exts is [""] on Unix; literal_ok branch above already covered it.
            let _ = &exts;
        }
    }
    None
}

/// What to hand `Command::new` for `cmd`: the resolved path when there is one,
/// otherwise `cmd` itself so the spawn error names what the user configured.
pub fn program_path(cmd: &str) -> PathBuf {
    resolve_program(cmd).unwrap_or_else(|| cmd.into())
}

/// Check if a command exists on PATH. Thin wrapper around [`resolve_program`].
pub fn command_exists(cmd: &str) -> bool {
    resolve_program(cmd).is_some()
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

/// Check if fzf is installed (for grove fp command)
#[cfg(not(windows))]
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

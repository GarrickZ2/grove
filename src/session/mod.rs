//! 统一 session 调度层 — 根据 SessionType 分发到 tmux、zellij 或 acp

use std::process::Command;
use std::str::FromStr;

use once_cell::sync::Lazy;

use crate::error::Result;
use crate::tmux::{self, SessionEnv};
use crate::zellij;

/// Session 类型枚举（用于内部调度）
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SessionType {
    Tmux,
    Zellij,
    Acp,
}

impl FromStr for SessionType {
    type Err = String;
    fn from_str(s: &str) -> std::result::Result<Self, Self::Err> {
        match s.to_lowercase().as_str() {
            "tmux" => Ok(SessionType::Tmux),
            "zellij" => Ok(SessionType::Zellij),
            "acp" => Ok(SessionType::Acp),
            _ => Err(format!("unknown session type: {}", s)),
        }
    }
}

/// Zellij session 名称最大长度 — 动态计算。
///
/// Zellij 使用 Unix domain socket `$TMPDIR/zellij-$UID/$VERSION/<session-name>`，
/// macOS `sun_path` 上限 104 字节，Linux 108 字节。
/// 在 macOS 上 TMPDIR 路径很长（/var/folders/...），实际可用约 36 字符。
static MAX_SESSION_NAME_LEN: Lazy<usize> = Lazy::new(compute_max_session_name_len);

fn compute_max_session_name_len() -> usize {
    #[cfg(target_os = "macos")]
    const SUN_PATH_MAX: usize = 104;
    #[cfg(not(target_os = "macos"))]
    const SUN_PATH_MAX: usize = 108;

    const FALLBACK: usize = 32;

    let tmpdir = std::env::var("TMPDIR").unwrap_or_else(|_| "/tmp/".to_string());
    let tmpdir = if tmpdir.ends_with('/') {
        tmpdir
    } else {
        format!("{}/", tmpdir)
    };

    let uid = Command::new("id")
        .arg("-u")
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| s.trim().to_string())
        .unwrap_or_default();
    if uid.is_empty() {
        return FALLBACK;
    }

    // Zellij socket path: $TMPDIR/zellij-$UID/<dir>/<session-name>
    // The <dir> is version-dependent:
    //   - Zellij <0.44: uses version string (e.g., "0.43.0")
    //   - Zellij >=0.44: uses "contract_version_1" (longer!)
    // Instead of guessing, probe the actual directory structure.
    let zellij_base_dir = format!("{}zellij-{}/", tmpdir, uid);
    let socket_dir = std::fs::read_dir(&zellij_base_dir)
        .ok()
        .and_then(|mut entries| {
            entries.find_map(|e| {
                let e = e.ok()?;
                let name = e.file_name().to_string_lossy().to_string();
                // Skip non-directories and log/cache files
                if e.file_type().ok()?.is_dir() && name != "zellij-log" && !name.ends_with(".cache")
                {
                    Some(name)
                } else {
                    None
                }
            })
        });

    let dir_name = match socket_dir {
        Some(d) => d,
        None => {
            // No zellij dir found — try version string as fallback
            let version = Command::new("zellij")
                .arg("--version")
                .output()
                .ok()
                .and_then(|o| String::from_utf8(o.stdout).ok())
                .map(|s| s.trim().replace("zellij ", ""))
                .unwrap_or_default();
            if version.is_empty() {
                return 100; // Zellij not installed
            }
            version
        }
    };

    let base = format!("{}zellij-{}/{}/", tmpdir, uid, dir_name);
    SUN_PATH_MAX
        .saturating_sub(base.len())
        .saturating_sub(1) // NUL terminator
        .max(10) // absolute minimum
}

/// 生成 session 名称（统一格式，与 multiplexer 无关）
///
/// 超过动态计算的上限时截断 task_slug 并追加 4 位哈希后缀，
/// 保证确定性且降低碰撞概率。
pub fn session_name(project: &str, task_slug: &str) -> String {
    let max_len = *MAX_SESSION_NAME_LEN;
    let full = format!("grove-{}-{}", project, task_slug);
    if full.len() <= max_len {
        return full;
    }

    // Hash both project and slug for deterministic uniqueness
    let hash = full.bytes().fold(0x811c_9dc5_u32, |h, b| {
        (h ^ b as u32).wrapping_mul(0x0100_0193)
    });
    let suffix = format!("{:04x}", hash & 0xffff);
    // suffix_part = "-xxxx" (5 chars)
    let suffix_part_len = 1 + suffix.len(); // dash + 4 hex

    // Budget for the "grove-{project}-{slug}" portion (before suffix)
    let body_budget = max_len.saturating_sub(suffix_part_len);
    // "grove-" = 6 chars
    const GROVE_PREFIX_LEN: usize = 6; // "grove-"

    if body_budget <= GROVE_PREFIX_LEN + 2 {
        // Extreme case: even "grove-" barely fits → just truncate full name + suffix
        let trunc = &full[..full.floor_char_boundary(body_budget)];
        let trunc = trunc.trim_end_matches('-');
        return format!("{}-{}", trunc, suffix);
    }

    // Split budget between project and slug: project gets up to 8 chars, rest to slug
    let proj_budget = (body_budget - GROVE_PREFIX_LEN - 1)
        .min(project.len())
        .min(8);
    // 1 for '-' between project and slug
    let slug_budget = body_budget
        .saturating_sub(GROVE_PREFIX_LEN)
        .saturating_sub(proj_budget)
        .saturating_sub(1);

    let proj_trunc = &project[..project.floor_char_boundary(proj_budget)];
    let proj_trunc = proj_trunc.trim_end_matches('-');

    let slug_end = task_slug
        .char_indices()
        .take_while(|&(i, c)| i + c.len_utf8() <= slug_budget)
        .last()
        .map_or(0, |(i, c)| i + c.len_utf8())
        .min(task_slug.len());
    let slug_trunc = &task_slug[..slug_end];
    let slug_trunc = slug_trunc.trim_end_matches('-');

    if slug_trunc.is_empty() {
        format!("grove-{}-{}", proj_trunc, suffix)
    } else {
        format!("grove-{}-{}-{}", proj_trunc, slug_trunc, suffix)
    }
}

/// 获取 task 的 session name — 优先使用 task 中持久化的名称，为空或超长时重新计算。
pub fn resolve_session_name(task_session_name: &str, project: &str, task_id: &str) -> String {
    if task_session_name.is_empty() || task_session_name.len() > *MAX_SESSION_NAME_LEN {
        session_name(project, task_id)
    } else {
        task_session_name.to_string()
    }
}

/// 创建 session
/// tmux: 创建 detached session
/// zellij: no-op（session 在 attach 时自动创建）
pub fn create_session(
    mux: &SessionType,
    name: &str,
    working_dir: &str,
    env: Option<&SessionEnv>,
) -> Result<()> {
    match mux {
        SessionType::Tmux => tmux::create_session(name, working_dir, env),
        SessionType::Zellij => zellij::create_session(name, working_dir, env),
        SessionType::Acp => Ok(()), // ACP session 按需通过 API 创建
    }
}

/// Attach 到 session（阻塞）
/// tmux: tmux attach-session -t <name>
/// zellij: zellij attach <name> --create（带可选 layout / working_dir / env）
/// acp: no-op（ACP 没有终端 attach 概念）
pub fn attach_session(
    mux: &SessionType,
    name: &str,
    working_dir: Option<&str>,
    env: Option<&SessionEnv>,
    layout_path: Option<&str>,
) -> Result<()> {
    match mux {
        SessionType::Tmux => tmux::attach_session(name),
        SessionType::Zellij => zellij::attach_session(name, working_dir, env, layout_path),
        SessionType::Acp => Ok(()), // ACP 通过 chat 界面交互，不需要 attach
    }
}

/// 检查 session 是否存在
pub fn session_exists(mux: &SessionType, name: &str) -> bool {
    match mux {
        SessionType::Tmux => tmux::session_exists(name),
        SessionType::Zellij => zellij::session_exists(name),
        SessionType::Acp => crate::acp::session_exists(name),
    }
}

/// 关闭 session
pub fn kill_session(mux: &SessionType, name: &str) -> Result<()> {
    match mux {
        SessionType::Tmux => tmux::kill_session(name),
        SessionType::Zellij => zellij::kill_session(name),
        SessionType::Acp => crate::acp::kill_session(name),
    }
}

/// 从 task 记录的 multiplexer 字符串解析为 SessionType 枚举
/// 如果 task 记录为空或未知值，默认返回 Tmux
pub fn resolve_session_type(task_mux: &str) -> SessionType {
    task_mux.parse::<SessionType>().unwrap_or(SessionType::Tmux)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_session_name_short() {
        // Short name stays as-is
        let name = session_name("abcdef1234567890", "my-task");
        assert_eq!(name, "grove-abcdef1234567890-my-task");
        assert!(name.len() <= *MAX_SESSION_NAME_LEN);
    }

    #[test]
    fn test_session_name_truncated() {
        // Long slug gets truncated with hash suffix
        let name = session_name(
            "1bb5b3564b3ae517",
            "this-is-a-very-long-task-name-for-testing",
        );
        let max = *MAX_SESSION_NAME_LEN;
        assert!(name.len() <= max, "len={} > max={}", name.len(), max);
        assert!(name.starts_with("grove-1bb5b3564b3ae517-"));
    }

    #[test]
    fn test_session_name_deterministic() {
        // Same input always produces same output
        let a = session_name(
            "1bb5b3564b3ae517",
            "this-is-a-very-long-task-name-for-testing",
        );
        let b = session_name(
            "1bb5b3564b3ae517",
            "this-is-a-very-long-task-name-for-testing",
        );
        assert_eq!(a, b);
    }

    #[test]
    fn test_session_name_different_slugs_differ() {
        // Different slugs produce different names (hash suffix differs)
        let a = session_name("1bb5b3564b3ae517", "very-long-task-name-alpha-extra-words");
        let b = session_name("1bb5b3564b3ae517", "very-long-task-name-bravo-extra-words");
        assert_ne!(a, b);
        let max = *MAX_SESSION_NAME_LEN;
        assert!(a.len() <= max);
        assert!(b.len() <= max);
    }

    #[test]
    fn test_session_name_unicode() {
        // Chinese characters (3 bytes each in UTF-8) must not panic
        let name = session_name("1bb5b3564b3ae517", "开发任务一");
        let max = *MAX_SESSION_NAME_LEN;
        assert!(name.len() <= max, "len={} > max={}", name.len(), max);
        assert!(name.starts_with("grove-1bb5b3564b3ae517-"));
        // Verify the result is valid UTF-8 (implicit — it's a String)
    }

    #[test]
    fn test_max_session_name_len_reasonable() {
        let max = *MAX_SESSION_NAME_LEN;
        // Must be at least 10 (our minimum) and at most ~100
        assert!(max >= 10, "max={} too small", max);
        assert!(max <= 108, "max={} too large", max);
    }
}

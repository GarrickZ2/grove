//! 统一 session 调度层 — 根据 Multiplexer 类型分发到 tmux 或 zellij

use std::process::Command;

use once_cell::sync::Lazy;

use crate::error::Result;
use crate::storage::config::Multiplexer;
use crate::tmux::{self, SessionEnv};
use crate::zellij;

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

    let version = Command::new("zellij")
        .arg("--version")
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| s.trim().replace("zellij ", ""))
        .unwrap_or_default();
    if version.is_empty() {
        // Zellij not installed — no constraint needed, use generous limit
        return 100;
    }

    // Socket path: $TMPDIR/zellij-$UID/$VERSION/<session-name>
    let base = format!("{}zellij-{}/{}/", tmpdir, uid, version);
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
    let prefix = format!("grove-{}-", project);
    // FNV-1a hash → 4 hex 字符
    let hash = task_slug.bytes().fold(0x811c_9dc5_u32, |h, b| {
        (h ^ b as u32).wrapping_mul(0x0100_0193)
    });
    let suffix = format!("{:04x}", hash & 0xffff);
    // 1 for '-' separator between truncated slug and hash suffix
    let avail = max_len.saturating_sub(prefix.len() + 1 + suffix.len());
    let truncated = &task_slug[..avail.min(task_slug.len())];
    // Trim trailing hyphens from truncation point
    let truncated = truncated.trim_end_matches('-');
    format!("{}{}-{}", prefix, truncated, suffix)
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
    mux: &Multiplexer,
    name: &str,
    working_dir: &str,
    env: Option<&SessionEnv>,
) -> Result<()> {
    match mux {
        Multiplexer::Tmux => tmux::create_session(name, working_dir, env),
        Multiplexer::Zellij => zellij::create_session(name, working_dir, env),
        Multiplexer::Acp => Ok(()), // ACP session 按需通过 API 创建
    }
}

/// Attach 到 session（阻塞）
/// tmux: tmux attach-session -t <name>
/// zellij: zellij attach <name> --create（带可选 layout / working_dir / env）
/// acp: no-op（ACP 没有终端 attach 概念）
pub fn attach_session(
    mux: &Multiplexer,
    name: &str,
    working_dir: Option<&str>,
    env: Option<&SessionEnv>,
    layout_path: Option<&str>,
) -> Result<()> {
    match mux {
        Multiplexer::Tmux => tmux::attach_session(name),
        Multiplexer::Zellij => zellij::attach_session(name, working_dir, env, layout_path),
        Multiplexer::Acp => Ok(()), // ACP 通过 chat 界面交互，不需要 attach
    }
}

/// 检查 session 是否存在
pub fn session_exists(mux: &Multiplexer, name: &str) -> bool {
    match mux {
        Multiplexer::Tmux => tmux::session_exists(name),
        Multiplexer::Zellij => zellij::session_exists(name),
        Multiplexer::Acp => crate::acp::session_exists(name),
    }
}

/// 关闭 session
pub fn kill_session(mux: &Multiplexer, name: &str) -> Result<()> {
    match mux {
        Multiplexer::Tmux => tmux::kill_session(name),
        Multiplexer::Zellij => zellij::kill_session(name),
        Multiplexer::Acp => crate::acp::kill_session(name),
    }
}

/// 从 task 记录的 multiplexer 字符串解析为 Multiplexer 枚举
/// 如果 task 记录为空或未知值，回退到全局配置
pub fn resolve_multiplexer(task_mux: &str, global_mux: &Multiplexer) -> Multiplexer {
    match task_mux.to_lowercase().as_str() {
        "tmux" => Multiplexer::Tmux,
        "zellij" => Multiplexer::Zellij,
        "acp" => Multiplexer::Acp,
        _ => global_mux.clone(),
    }
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
    fn test_max_session_name_len_reasonable() {
        let max = *MAX_SESSION_NAME_LEN;
        // Must be at least 10 (our minimum) and at most ~100
        assert!(max >= 10, "max={} too small", max);
        assert!(max <= 108, "max={} too large", max);
    }
}

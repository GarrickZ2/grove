//! 统一 session 调度层 — 根据 Multiplexer 类型分发到 tmux 或 zellij

use crate::storage::config::Multiplexer;
use crate::tmux::{self, SessionEnv};
use crate::zellij;

/// 生成 session 名称（统一格式，与 multiplexer 无关）
pub fn session_name(project: &str, task_slug: &str) -> String {
    format!("grove-{}-{}", project, task_slug)
}

/// 创建 session
/// tmux: 创建 detached session
/// zellij: no-op（session 在 attach 时自动创建）
pub fn create_session(
    mux: &Multiplexer,
    name: &str,
    working_dir: &str,
    env: Option<&SessionEnv>,
) -> Result<(), String> {
    match mux {
        Multiplexer::Tmux => tmux::create_session(name, working_dir, env),
        Multiplexer::Zellij => zellij::create_session(name, working_dir, env),
    }
}

/// Attach 到 session（阻塞）
/// tmux: tmux attach-session -t <name>
/// zellij: zellij attach <name> --create（带可选 layout / working_dir / env）
pub fn attach_session(
    mux: &Multiplexer,
    name: &str,
    working_dir: Option<&str>,
    env: Option<&SessionEnv>,
    layout_path: Option<&str>,
) -> Result<(), String> {
    match mux {
        Multiplexer::Tmux => tmux::attach_session(name),
        Multiplexer::Zellij => zellij::attach_session(name, working_dir, env, layout_path),
    }
}

/// 检查 session 是否存在
pub fn session_exists(mux: &Multiplexer, name: &str) -> bool {
    match mux {
        Multiplexer::Tmux => tmux::session_exists(name),
        Multiplexer::Zellij => zellij::session_exists(name),
    }
}

/// 关闭 session
pub fn kill_session(mux: &Multiplexer, name: &str) -> Result<(), String> {
    match mux {
        Multiplexer::Tmux => tmux::kill_session(name),
        Multiplexer::Zellij => zellij::kill_session(name),
    }
}

/// 从 task 记录的 multiplexer 字符串解析为 Multiplexer 枚举
/// 如果 task 记录为空或未知值，回退到全局配置
pub fn resolve_multiplexer(task_mux: &str, global_mux: &Multiplexer) -> Multiplexer {
    match task_mux.to_lowercase().as_str() {
        "tmux" => Multiplexer::Tmux,
        "zellij" => Multiplexer::Zellij,
        _ => global_mux.clone(),
    }
}

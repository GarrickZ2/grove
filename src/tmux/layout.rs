//! Task 布局预设（tmux pane 布局）

use std::process::Command;

/// 布局预设
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TaskLayout {
    /// 单窗口 shell（默认）
    Single,
    /// 单窗口自动启动 agent
    Agent,
    /// 左 agent (60%) + 右 shell (40%)
    AgentShell,
    /// 左 agent (60%) + 右上 grove monitor + 右下 shell
    AgentMonitor,
    /// 左 grove monitor (40%) + 右 agent (60%)
    GroveAgent,
}

impl TaskLayout {
    pub fn all() -> &'static [TaskLayout] {
        &[
            TaskLayout::Single,
            TaskLayout::Agent,
            TaskLayout::AgentShell,
            TaskLayout::AgentMonitor,
            TaskLayout::GroveAgent,
        ]
    }

    /// UI 显示名
    pub fn label(&self) -> &'static str {
        match self {
            TaskLayout::Single => "Single",
            TaskLayout::Agent => "Agent",
            TaskLayout::AgentShell => "Agent + Shell",
            TaskLayout::AgentMonitor => "Agent + Monitor",
            TaskLayout::GroveAgent => "Grove + Agent",
        }
    }

    /// config 存储名
    pub fn name(&self) -> &'static str {
        match self {
            TaskLayout::Single => "single",
            TaskLayout::Agent => "agent",
            TaskLayout::AgentShell => "agent-shell",
            TaskLayout::AgentMonitor => "agent-monitor",
            TaskLayout::GroveAgent => "grove-agent",
        }
    }

    /// 从 config 名称解析
    pub fn from_name(s: &str) -> Option<Self> {
        match s {
            "single" => Some(TaskLayout::Single),
            "agent" => Some(TaskLayout::Agent),
            "agent-shell" => Some(TaskLayout::AgentShell),
            "agent-monitor" => Some(TaskLayout::AgentMonitor),
            "grove-agent" => Some(TaskLayout::GroveAgent),
            _ => None,
        }
    }
}

/// 查询 session 中所有 pane 的 ID（%N 格式，不受 base-index 影响）
fn list_pane_ids(session: &str) -> Result<Vec<String>, String> {
    let output = Command::new("tmux")
        .args(["list-panes", "-t", session, "-F", "#{pane_id}"])
        .output()
        .map_err(|e| format!("list-panes failed: {}", e))?;

    if !output.status.success() {
        return Err(format!(
            "list-panes failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }

    Ok(String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(|s| s.to_string())
        .collect())
}

/// 在已创建的 tmux session 上应用布局
///
/// 使用 pane ID（%N 格式）进行寻址，兼容任意 base-index / pane-base-index 配置。
pub fn apply_layout(
    session: &str,
    working_dir: &str,
    layout: &TaskLayout,
    agent_command: &str,
) -> Result<(), String> {
    match layout {
        TaskLayout::Single => Ok(()),

        TaskLayout::Agent => {
            // 单窗口，直接发送 agent 命令
            let panes = list_pane_ids(session)?;
            let agent = panes.first().ok_or("no pane found")?;
            if !agent_command.is_empty() {
                send_keys(agent, agent_command)?;
            }
            Ok(())
        }

        TaskLayout::AgentShell => {
            // +-------------+-------------+
            // |   agent     |   shell     |
            // |   (60%)     |   (40%)     |
            // +-------------+-------------+
            let panes = list_pane_ids(session)?;
            let agent = panes.first().ok_or("no pane found")?.clone();

            split_window_horizontal(&agent, working_dir, 40)?;

            if !agent_command.is_empty() {
                send_keys(&agent, agent_command)?;
            }
            select_pane(&agent)?;
            Ok(())
        }

        TaskLayout::AgentMonitor => {
            // +-------------+-------------+
            // |             |   grove     |
            // |   agent     |  (monitor)  |
            // |   (60%)     +-------------+
            // |             |   shell     |
            // +-------------+-------------+
            let panes = list_pane_ids(session)?;
            let agent = panes.first().ok_or("no pane found")?.clone();

            // split-h: agent | right
            split_window_horizontal(&agent, working_dir, 40)?;

            // 查询 split 后的 pane 列表，第二个就是 right pane
            let panes = list_pane_ids(session)?;
            let grove = panes.get(1).ok_or("split failed: no second pane")?.clone();

            // split-v right: grove | shell
            split_window_vertical(&grove, working_dir, 60)?;

            // grove pane ID 不变（split-v 在它下方新建了 shell）
            if !agent_command.is_empty() {
                send_keys(&agent, agent_command)?;
            }
            send_keys(&grove, "grove")?;
            select_pane(&agent)?;
            Ok(())
        }

        TaskLayout::GroveAgent => {
            // +-------------+-------------+
            // |   grove     |   agent     |
            // |  (monitor)  |   (60%)     |
            // |   (40%)     |             |
            // +-------------+-------------+
            let panes = list_pane_ids(session)?;
            let grove = panes.first().ok_or("no pane found")?.clone();

            // split-h: grove (40%) | agent (60%)
            split_window_horizontal(&grove, working_dir, 60)?;

            // 查询 split 后的 pane 列表，第二个是 agent pane
            let panes = list_pane_ids(session)?;
            let agent = panes.get(1).ok_or("split failed: no second pane")?.clone();

            send_keys(&grove, "grove")?;
            if !agent_command.is_empty() {
                send_keys(&agent, agent_command)?;
            }
            select_pane(&agent)?;
            Ok(())
        }
    }
}

/// 执行 tmux 命令的通用辅助函数
fn tmux_cmd(args: &[&str]) -> Result<(), String> {
    let output = Command::new("tmux")
        .args(args)
        .output()
        .map_err(|e| format!("tmux {} failed: {}", args[0], e))?;

    if output.status.success() {
        Ok(())
    } else {
        Err(format!(
            "tmux {} failed: {}",
            args[0],
            String::from_utf8_lossy(&output.stderr).trim()
        ))
    }
}

/// tmux split-window -h (水平分割，创建左右布局)
/// target: pane ID（%N 格式）
fn split_window_horizontal(target: &str, working_dir: &str, percentage: u8) -> Result<(), String> {
    let pct = percentage.to_string();
    tmux_cmd(&[
        "split-window",
        "-h",
        "-t",
        target,
        "-c",
        working_dir,
        "-p",
        &pct,
    ])
}

/// tmux split-window -v (纵向分割，创建上下布局)
/// target: pane ID（%N 格式）
fn split_window_vertical(target: &str, working_dir: &str, percentage: u8) -> Result<(), String> {
    let pct = percentage.to_string();
    tmux_cmd(&[
        "split-window",
        "-v",
        "-t",
        target,
        "-c",
        working_dir,
        "-p",
        &pct,
    ])
}

/// tmux send-keys
/// target: pane ID（%N 格式）
fn send_keys(target: &str, command: &str) -> Result<(), String> {
    tmux_cmd(&["send-keys", "-t", target, command, "Enter"])
}

/// tmux select-pane
/// target: pane ID（%N 格式）
fn select_pane(target: &str) -> Result<(), String> {
    tmux_cmd(&["select-pane", "-t", target])
}

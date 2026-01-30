//! Task 布局预设（tmux pane 布局）

use serde::{Deserialize, Serialize};
use std::process::Command;

// ── Custom layout data model ─────────────────────────────────────────

/// Pane 角色（叶子节点）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PaneRole {
    Agent,
    Grove,
    Shell,
    Custom(String),
}

/// 分割方向
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SplitDirection {
    /// 水平分割（左|右）
    #[serde(rename = "h")]
    Horizontal,
    /// 垂直分割（上/下）
    #[serde(rename = "v")]
    Vertical,
}

/// 布局树节点
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum LayoutNode {
    /// 分割: 方向 + 左/上子节点 + 右/下子节点 + 比例
    Split {
        dir: SplitDirection,
        ratio: u8,
        first: Box<LayoutNode>,
        second: Box<LayoutNode>,
    },
    /// 叶子: 具体的 pane
    Pane { pane: PaneRole },
    /// 占位: 尚未配置的节点（构建过程中使用）
    Placeholder,
}

impl LayoutNode {
    /// 统计叶子节点数（不含 Placeholder）
    pub fn pane_count(&self) -> usize {
        match self {
            LayoutNode::Pane { .. } => 1,
            LayoutNode::Placeholder => 1, // placeholder 占一个位置
            LayoutNode::Split { first, second, .. } => first.pane_count() + second.pane_count(),
        }
    }

    /// 所有叶子是否已分配（无 Placeholder）
    #[allow(dead_code)]
    pub fn is_complete(&self) -> bool {
        match self {
            LayoutNode::Pane { .. } => true,
            LayoutNode::Placeholder => false,
            LayoutNode::Split { first, second, .. } => first.is_complete() && second.is_complete(),
        }
    }
}

/// 路径段：标识树中的位置
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PathSegment {
    First,
    Second,
}

/// 在树的指定路径位置设置节点
pub fn set_node_at_path(root: &mut LayoutNode, path: &[PathSegment], node: LayoutNode) {
    if path.is_empty() {
        *root = node;
        return;
    }

    if let LayoutNode::Split {
        ref mut first,
        ref mut second,
        ..
    } = root
    {
        match path[0] {
            PathSegment::First => set_node_at_path(first, &path[1..], node),
            PathSegment::Second => set_node_at_path(second, &path[1..], node),
        }
    }
}

/// 找到下一个未配置的叶子路径（DFS 前序）
pub fn next_incomplete_path(root: &LayoutNode) -> Option<Vec<PathSegment>> {
    match root {
        LayoutNode::Placeholder => Some(vec![]),
        LayoutNode::Pane { .. } => None,
        LayoutNode::Split { first, second, .. } => {
            if let Some(mut path) = next_incomplete_path(first) {
                path.insert(0, PathSegment::First);
                Some(path)
            } else if let Some(mut path) = next_incomplete_path(second) {
                path.insert(0, PathSegment::Second);
                Some(path)
            } else {
                None
            }
        }
    }
}

/// 自定义布局
#[derive(Debug, Clone)]
pub struct CustomLayout {
    pub root: LayoutNode,
}

// ── TaskLayout enum ──────────────────────────────────────────────────

/// 布局预设
#[derive(Debug, Clone, PartialEq, Eq)]
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
    /// 自定义布局
    Custom,
}

impl TaskLayout {
    /// 所有预设布局（不含 Custom）
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
            TaskLayout::Custom => "Custom",
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
            TaskLayout::Custom => "custom",
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
            "custom" => Some(TaskLayout::Custom),
            _ => None,
        }
    }
}

// ── apply layout functions ───────────────────────────────────────────

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
    custom_layout: Option<&CustomLayout>,
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

        TaskLayout::Custom => {
            let cl = custom_layout.ok_or("No custom layout configured")?;
            apply_custom_layout(session, working_dir, cl, agent_command)
        }
    }
}

/// 应用自定义布局树
pub fn apply_custom_layout(
    session: &str,
    working_dir: &str,
    layout: &CustomLayout,
    agent_command: &str,
) -> Result<(), String> {
    let panes = list_pane_ids(session)?;
    let root_pane = panes.first().ok_or("no pane found")?.clone();

    let mut first_agent_pane: Option<String> = None;

    apply_node(
        session,
        working_dir,
        &layout.root,
        &root_pane,
        agent_command,
        &mut first_agent_pane,
    )?;

    // 选择第一个 Agent pane，若无则选 root pane
    let focus = first_agent_pane.as_deref().unwrap_or(&root_pane);
    select_pane(focus)?;

    Ok(())
}

/// 递归应用布局节点
fn apply_node(
    session: &str,
    working_dir: &str,
    node: &LayoutNode,
    target_pane: &str,
    agent_command: &str,
    first_agent: &mut Option<String>,
) -> Result<(), String> {
    match node {
        LayoutNode::Pane { pane } => {
            // 在 target pane 上发送命令
            match pane {
                PaneRole::Agent => {
                    if first_agent.is_none() {
                        *first_agent = Some(target_pane.to_string());
                    }
                    if !agent_command.is_empty() {
                        send_keys(target_pane, agent_command)?;
                    }
                }
                PaneRole::Grove => {
                    send_keys(target_pane, "grove")?;
                }
                PaneRole::Shell => {
                    // shell 不需要发命令
                }
                PaneRole::Custom(cmd) => {
                    if !cmd.is_empty() {
                        send_keys(target_pane, cmd)?;
                    }
                }
            }
            Ok(())
        }
        LayoutNode::Split {
            dir,
            ratio,
            first,
            second,
        } => {
            // split target pane: second 是新创建的 pane
            let second_pct = 100u8.saturating_sub(*ratio);
            match dir {
                SplitDirection::Horizontal => {
                    split_window_horizontal(target_pane, working_dir, second_pct)?;
                }
                SplitDirection::Vertical => {
                    split_window_vertical(target_pane, working_dir, second_pct)?;
                }
            }

            // split 后，target_pane 仍是 first，新 pane 是最后一个
            let panes = list_pane_ids(session)?;
            let new_pane = panes.last().ok_or("split failed: no new pane")?.clone();

            // 递归处理两个子节点
            apply_node(
                session,
                working_dir,
                first,
                target_pane,
                agent_command,
                first_agent,
            )?;
            apply_node(
                session,
                working_dir,
                second,
                &new_pane,
                agent_command,
                first_agent,
            )?;

            Ok(())
        }
        LayoutNode::Placeholder => Ok(()),
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

//! Task 布局预设（tmux pane 布局）

use serde::{Deserialize, Serialize};
use std::process::Command;

use crate::error::{GroveError, Result};

// ── Custom layout data model ─────────────────────────────────────────

/// Pane 角色（叶子节点）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PaneRole {
    Agent,
    Grove,
    Shell,
    FilePicker,
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
fn list_pane_ids(session: &str) -> Result<Vec<String>> {
    let output = Command::new("tmux")
        .args(["list-panes", "-t", session, "-F", "#{pane_id}"])
        .output()
        .map_err(|e| GroveError::session(format!("list-panes failed: {}", e)))?;

    if !output.status.success() {
        return Err(GroveError::session(format!(
            "list-panes failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        )));
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
) -> Result<()> {
    match layout {
        TaskLayout::Single => Ok(()),

        TaskLayout::Agent => {
            // 单窗口，直接发送 agent 命令
            let panes = list_pane_ids(session)?;
            let agent = panes
                .first()
                .ok_or_else(|| GroveError::session("no pane found"))?;
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
            let agent = panes
                .first()
                .ok_or_else(|| GroveError::session("no pane found"))?
                .clone();

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
            let agent = panes
                .first()
                .ok_or_else(|| GroveError::session("no pane found"))?
                .clone();

            // split-h: agent | right
            split_window_horizontal(&agent, working_dir, 40)?;

            // 查询 split 后的 pane 列表，第二个就是 right pane
            let panes = list_pane_ids(session)?;
            let grove = panes
                .get(1)
                .ok_or_else(|| GroveError::session("split failed: no second pane"))?
                .clone();

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
            let grove = panes
                .first()
                .ok_or_else(|| GroveError::session("no pane found"))?
                .clone();

            // split-h: grove (40%) | agent (60%)
            split_window_horizontal(&grove, working_dir, 60)?;

            // 查询 split 后的 pane 列表，第二个是 agent pane
            let panes = list_pane_ids(session)?;
            let agent = panes
                .get(1)
                .ok_or_else(|| GroveError::session("split failed: no second pane"))?
                .clone();

            send_keys(&grove, "grove")?;
            if !agent_command.is_empty() {
                send_keys(&agent, agent_command)?;
            }
            select_pane(&agent)?;
            Ok(())
        }

        TaskLayout::Custom => {
            let cl =
                custom_layout.ok_or_else(|| GroveError::config("No custom layout configured"))?;
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
) -> Result<()> {
    let panes = list_pane_ids(session)?;
    let root_pane = panes
        .first()
        .ok_or_else(|| GroveError::session("no pane found"))?
        .clone();

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
) -> Result<()> {
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
                PaneRole::FilePicker => {
                    send_keys(target_pane, "grove fp")?;
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
            // split 前记录已有 pane，用于 split 后找到新创建的 pane
            let before: std::collections::HashSet<String> =
                list_pane_ids(session)?.into_iter().collect();

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

            // split 后，通过差集找到新创建的 pane
            let after = list_pane_ids(session)?;
            let new_pane = after
                .into_iter()
                .find(|p| !before.contains(p))
                .ok_or_else(|| GroveError::session("split failed: no new pane found"))?;

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
fn tmux_cmd(args: &[&str]) -> Result<()> {
    let output = Command::new("tmux")
        .args(args)
        .output()
        .map_err(|e| GroveError::session(format!("tmux {} failed: {}", args[0], e)))?;

    if output.status.success() {
        Ok(())
    } else {
        Err(GroveError::session(format!(
            "tmux {} failed: {}",
            args[0],
            String::from_utf8_lossy(&output.stderr).trim()
        )))
    }
}

/// tmux split-window -h (水平分割，创建左右布局)
/// target: pane ID（%N 格式）
fn split_window_horizontal(target: &str, working_dir: &str, percentage: u8) -> Result<()> {
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
fn split_window_vertical(target: &str, working_dir: &str, percentage: u8) -> Result<()> {
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
fn send_keys(target: &str, command: &str) -> Result<()> {
    tmux_cmd(&["send-keys", "-t", target, command, "Enter"])
}

/// tmux select-pane
/// target: pane ID（%N 格式）
fn select_pane(target: &str) -> Result<()> {
    tmux_cmd(&["select-pane", "-t", target])
}

// ── Web format compatibility ──────────────────────────────────────────

/// Web 格式的布局节点（用于解析 grove-web 保存的配置）
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebLayoutNode {
    #[allow(dead_code)]
    pub id: String,
    #[serde(rename = "type")]
    pub node_type: String,
    /// "vertical" | "horizontal" (for split nodes)
    pub direction: Option<String>,
    /// "shell" | "agent" | "grove" (for pane nodes)
    pub pane_type: Option<String>,
    /// Child nodes (for split nodes)
    pub children: Option<Vec<WebLayoutNode>>,
}

/// Web 格式的自定义布局（带 ID 和名称）
#[derive(Debug, Clone, Deserialize)]
pub struct WebCustomLayout {
    pub id: String,
    #[allow(dead_code)]
    pub name: String,
    pub root: WebLayoutNode,
}

/// 将 Web 格式的节点转换为 TUI 格式
fn convert_web_node(web_node: &WebLayoutNode) -> Option<LayoutNode> {
    match web_node.node_type.as_str() {
        "pane" => {
            let pane_type = web_node.pane_type.as_deref().unwrap_or("shell");
            let pane = match pane_type {
                "agent" => PaneRole::Agent,
                "grove" => PaneRole::Grove,
                "shell" => PaneRole::Shell,
                "file-picker" | "filePicker" => PaneRole::FilePicker,
                other => PaneRole::Custom(other.to_string()),
            };
            Some(LayoutNode::Pane { pane })
        }
        "split" => {
            let children = web_node.children.as_ref()?;
            if children.len() < 2 {
                return None;
            }

            // Web 的 direction: "vertical" 表示上下分割，"horizontal" 表示左右分割
            // TUI 的 SplitDirection::Vertical 表示上下分割（v），Horizontal 表示左右分割（h）
            let dir = match web_node.direction.as_deref() {
                Some("vertical") => SplitDirection::Vertical,
                Some("horizontal") => SplitDirection::Horizontal,
                _ => SplitDirection::Horizontal, // default
            };

            // 递归转换子节点
            let first = convert_web_node(&children[0])?;
            let second = if children.len() == 2 {
                convert_web_node(&children[1])?
            } else {
                // 超过 2 个子节点时，递归合并
                let mut remaining = WebLayoutNode {
                    id: "merged".to_string(),
                    node_type: "split".to_string(),
                    direction: web_node.direction.clone(),
                    pane_type: None,
                    children: Some(children[1..].to_vec()),
                };
                // 如果只剩 2 个，正常处理
                if children.len() == 3 {
                    remaining = children[1].clone();
                    let third = convert_web_node(&children[2])?;
                    // 创建一个中间 split 节点
                    let second_converted = convert_web_node(&remaining)?;
                    LayoutNode::Split {
                        dir,
                        ratio: 50,
                        first: Box::new(second_converted),
                        second: Box::new(third),
                    }
                } else {
                    convert_web_node(&remaining)?
                }
            };

            Some(LayoutNode::Split {
                dir,
                ratio: 50, // Web 格式没有 ratio，默认 50%
                first: Box::new(first),
                second: Box::new(second),
            })
        }
        _ => None,
    }
}

/// 解析 Web 格式的自定义布局配置
/// 支持两种格式：
/// 1. TUI 格式：直接的 LayoutNode JSON
/// 2. Web 格式：[{id, name, root}] 数组
pub fn parse_custom_layout_tree(json_str: &str, selected_id: Option<&str>) -> Option<LayoutNode> {
    // 首先尝试解析为 TUI 原生格式
    if let Ok(node) = serde_json::from_str::<LayoutNode>(json_str) {
        return Some(node);
    }

    // 尝试解析为 Web 格式数组
    if let Ok(layouts) = serde_json::from_str::<Vec<WebCustomLayout>>(json_str) {
        if layouts.is_empty() {
            return None;
        }

        // 根据 selected_id 选择布局，如果没有则使用第一个
        let layout = if let Some(id) = selected_id {
            layouts.iter().find(|l| l.id == id).or(layouts.first())?
        } else {
            layouts.first()?
        };

        return convert_web_node(&layout.root);
    }

    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_tui_format() {
        // TUI 原生格式
        let json = r#"{"pane":"shell"}"#;
        let result = parse_custom_layout_tree(json, None);
        assert!(result.is_some());
        assert!(matches!(
            result,
            Some(LayoutNode::Pane {
                pane: PaneRole::Shell
            })
        ));
    }

    #[test]
    fn test_parse_web_format_simple() {
        // Web 格式 - 简单 pane
        let json = r#"[{"id":"test1","name":"Test Layout","root":{"id":"pane1","type":"pane","paneType":"agent"}}]"#;
        let result = parse_custom_layout_tree(json, None);
        assert!(result.is_some());
        assert!(matches!(
            result,
            Some(LayoutNode::Pane {
                pane: PaneRole::Agent
            })
        ));
    }

    #[test]
    fn test_parse_web_format_split() {
        // Web 格式 - 分割布局
        let json = r#"[{"id":"test1","name":"Test Layout","root":{"id":"split1","type":"split","direction":"horizontal","children":[{"id":"pane1","type":"pane","paneType":"agent"},{"id":"pane2","type":"pane","paneType":"shell"}]}}]"#;
        let result = parse_custom_layout_tree(json, None);
        assert!(result.is_some());
        if let Some(LayoutNode::Split {
            dir, first, second, ..
        }) = result
        {
            assert_eq!(dir, SplitDirection::Horizontal);
            assert!(matches!(
                *first,
                LayoutNode::Pane {
                    pane: PaneRole::Agent
                }
            ));
            assert!(matches!(
                *second,
                LayoutNode::Pane {
                    pane: PaneRole::Shell
                }
            ));
        } else {
            panic!("Expected Split node");
        }
    }

    #[test]
    fn test_parse_web_format_selected_id() {
        // Web 格式 - 多个布局，选择指定 ID
        let json = r#"[
            {"id":"layout1","name":"Layout 1","root":{"id":"pane1","type":"pane","paneType":"shell"}},
            {"id":"layout2","name":"Layout 2","root":{"id":"pane2","type":"pane","paneType":"agent"}}
        ]"#;

        // 选择 layout2
        let result = parse_custom_layout_tree(json, Some("layout2"));
        assert!(result.is_some());
        assert!(matches!(
            result,
            Some(LayoutNode::Pane {
                pane: PaneRole::Agent
            })
        ));

        // 选择 layout1
        let result = parse_custom_layout_tree(json, Some("layout1"));
        assert!(result.is_some());
        assert!(matches!(
            result,
            Some(LayoutNode::Pane {
                pane: PaneRole::Shell
            })
        ));
    }

    #[test]
    fn test_parse_web_format_vertical_split() {
        // Web 格式 - 垂直分割
        let json = r#"[{"id":"test1","name":"Test","root":{"id":"s1","type":"split","direction":"vertical","children":[{"id":"p1","type":"pane","paneType":"grove"},{"id":"p2","type":"pane","paneType":"shell"}]}}]"#;
        let result = parse_custom_layout_tree(json, None);
        assert!(result.is_some());
        if let Some(LayoutNode::Split {
            dir, first, second, ..
        }) = result
        {
            assert_eq!(dir, SplitDirection::Vertical);
            assert!(matches!(
                *first,
                LayoutNode::Pane {
                    pane: PaneRole::Grove
                }
            ));
            assert!(matches!(
                *second,
                LayoutNode::Pane {
                    pane: PaneRole::Shell
                }
            ));
        } else {
            panic!("Expected Split node");
        }
    }
}

//! Zellij KDL layout 生成

use std::fs;
use std::path::PathBuf;

use crate::tmux::layout::{CustomLayout, LayoutNode, PaneRole, SplitDirection, TaskLayout};

/// 获取 session layout 目录
fn session_layout_dir() -> PathBuf {
    let dir = dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("/tmp"))
        .join(".grove")
        .join("layouts")
        .join("sessions");
    let _ = fs::create_dir_all(&dir);
    dir
}

/// 生成 KDL layout 内容
pub fn generate_kdl(
    layout: &TaskLayout,
    agent_command: &str,
    custom_layout: Option<&CustomLayout>,
) -> String {
    match layout {
        TaskLayout::Single => {
            // 单 pane，空 layout
            "layout {\n    pane\n}\n".to_string()
        }
        TaskLayout::Agent => {
            if agent_command.is_empty() {
                "layout {\n    pane\n}\n".to_string()
            } else {
                format!(
                    "layout {{\n    pane command=\"sh\" {{\n        args \"-c\" \"{}\"\n    }}\n}}\n",
                    escape_kdl(agent_command)
                )
            }
        }
        TaskLayout::AgentShell => {
            let agent_pane = if agent_command.is_empty() {
                "        pane size=\"60%\"".to_string()
            } else {
                format!(
                    "        pane size=\"60%\" command=\"sh\" {{\n            args \"-c\" \"{}\"\n        }}",
                    escape_kdl(agent_command)
                )
            };
            format!(
                "layout {{\n    pane split_direction=\"vertical\" {{\n{}\n        pane size=\"40%\"\n    }}\n}}\n",
                agent_pane
            )
        }
        TaskLayout::AgentMonitor => {
            // agent (60%) | right(grove + shell)
            let agent_pane = if agent_command.is_empty() {
                "        pane size=\"60%\"".to_string()
            } else {
                format!(
                    "        pane size=\"60%\" command=\"sh\" {{\n            args \"-c\" \"{}\"\n        }}",
                    escape_kdl(agent_command)
                )
            };
            format!(
                "layout {{\n    pane split_direction=\"vertical\" {{\n{}\n        pane size=\"40%\" split_direction=\"horizontal\" {{\n            pane size=\"60%\" command=\"sh\" {{\n                args \"-c\" \"grove\"\n            }}\n            pane size=\"40%\"\n        }}\n    }}\n}}\n",
                agent_pane
            )
        }
        TaskLayout::GroveAgent => {
            // grove (40%) | agent (60%)
            let agent_pane = if agent_command.is_empty() {
                "        pane size=\"60%\"".to_string()
            } else {
                format!(
                    "        pane size=\"60%\" command=\"sh\" {{\n            args \"-c\" \"{}\"\n        }}",
                    escape_kdl(agent_command)
                )
            };
            format!(
                "layout {{\n    pane split_direction=\"vertical\" {{\n        pane size=\"40%\" command=\"sh\" {{\n            args \"-c\" \"grove\"\n        }}\n{}\n    }}\n}}\n",
                agent_pane
            )
        }
        TaskLayout::Custom => {
            if let Some(cl) = custom_layout {
                let mut buf = String::new();
                buf.push_str("layout {\n");
                generate_node_kdl(&cl.root, agent_command, &mut buf, 1);
                buf.push_str("}\n");
                buf
            } else {
                "layout {\n    pane\n}\n".to_string()
            }
        }
    }
}

/// 递归生成 LayoutNode 的 KDL 内容
fn generate_node_kdl(node: &LayoutNode, agent_command: &str, buf: &mut String, indent: usize) {
    let pad = "    ".repeat(indent);
    match node {
        LayoutNode::Pane { pane } => match pane {
            PaneRole::Agent => {
                if agent_command.is_empty() {
                    buf.push_str(&format!("{}pane\n", pad));
                } else {
                    buf.push_str(&format!(
                        "{}pane command=\"sh\" {{\n{}    args \"-c\" \"{}\"\n{}}}\n",
                        pad,
                        pad,
                        escape_kdl(agent_command),
                        pad,
                    ));
                }
            }
            PaneRole::Grove => {
                buf.push_str(&format!(
                    "{}pane command=\"sh\" {{\n{}    args \"-c\" \"grove\"\n{}}}\n",
                    pad, pad, pad,
                ));
            }
            PaneRole::Shell => {
                buf.push_str(&format!("{}pane\n", pad));
            }
            PaneRole::FilePicker => {
                buf.push_str(&format!(
                    "{}pane command=\"sh\" {{\n{}    args \"-c\" \"grove fp\"\n{}}}\n",
                    pad, pad, pad,
                ));
            }
            PaneRole::Custom(cmd) => {
                if cmd.is_empty() {
                    buf.push_str(&format!("{}pane\n", pad));
                } else {
                    buf.push_str(&format!(
                        "{}pane command=\"sh\" {{\n{}    args \"-c\" \"{}\"\n{}}}\n",
                        pad,
                        pad,
                        escape_kdl(cmd),
                        pad,
                    ));
                }
            }
        },
        LayoutNode::Split {
            dir,
            ratio,
            first,
            second,
        } => {
            let direction = match dir {
                SplitDirection::Horizontal => "vertical", // KDL: left|right = vertical split
                SplitDirection::Vertical => "horizontal", // KDL: top|bottom = horizontal split
            };
            let first_pct = *ratio as u32;
            let second_pct = 100u32.saturating_sub(first_pct);
            buf.push_str(&format!(
                "{}pane split_direction=\"{}\" {{\n",
                pad, direction
            ));
            // First child with ratio
            buf.push_str(&format!("{}    // size=\"{}%\"\n", pad, first_pct));
            generate_node_kdl_sized(first, agent_command, buf, indent + 1, first_pct);
            // Second child
            buf.push_str(&format!("{}    // size=\"{}%\"\n", pad, second_pct));
            generate_node_kdl_sized(second, agent_command, buf, indent + 1, second_pct);
            buf.push_str(&format!("{}}}\n", pad));
        }
        LayoutNode::Placeholder => {
            buf.push_str(&format!("{}pane\n", pad));
        }
    }
}

/// 带 size 属性的节点 KDL 生成
fn generate_node_kdl_sized(
    node: &LayoutNode,
    agent_command: &str,
    buf: &mut String,
    indent: usize,
    size_pct: u32,
) {
    let pad = "    ".repeat(indent);
    match node {
        LayoutNode::Pane { pane } => {
            let size = format!("size=\"{}%\"", size_pct);
            match pane {
                PaneRole::Agent => {
                    if agent_command.is_empty() {
                        buf.push_str(&format!("{}pane {}\n", pad, size));
                    } else {
                        buf.push_str(&format!(
                            "{}pane {} command=\"sh\" {{\n{}    args \"-c\" \"{}\"\n{}}}\n",
                            pad,
                            size,
                            pad,
                            escape_kdl(agent_command),
                            pad,
                        ));
                    }
                }
                PaneRole::Grove => {
                    buf.push_str(&format!(
                        "{}pane {} command=\"sh\" {{\n{}    args \"-c\" \"grove\"\n{}}}\n",
                        pad, size, pad, pad,
                    ));
                }
                PaneRole::Shell => {
                    buf.push_str(&format!("{}pane {}\n", pad, size));
                }
                PaneRole::FilePicker => {
                    buf.push_str(&format!(
                        "{}pane {} command=\"sh\" {{\n{}    args \"-c\" \"grove fp\"\n{}}}\n",
                        pad, size, pad, pad,
                    ));
                }
                PaneRole::Custom(cmd) => {
                    if cmd.is_empty() {
                        buf.push_str(&format!("{}pane {}\n", pad, size));
                    } else {
                        buf.push_str(&format!(
                            "{}pane {} command=\"sh\" {{\n{}    args \"-c\" \"{}\"\n{}}}\n",
                            pad,
                            size,
                            pad,
                            escape_kdl(cmd),
                            pad,
                        ));
                    }
                }
            }
        }
        LayoutNode::Split { .. } => {
            // Nested split - delegate to normal generation (size on split not directly supported,
            // but we wrap it)
            generate_node_kdl(node, agent_command, buf, indent);
        }
        LayoutNode::Placeholder => {
            buf.push_str(&format!("{}pane size=\"{}%\"\n", pad, size_pct));
        }
    }
}

/// 写入 session layout KDL 文件
pub fn write_session_layout(session_name: &str, kdl_content: &str) -> Result<String, String> {
    let dir = session_layout_dir();
    let path = dir.join(format!("{}.kdl", session_name));
    fs::write(&path, kdl_content).map_err(|e| format!("Failed to write layout file: {}", e))?;
    Ok(path.to_string_lossy().to_string())
}

/// 删除 session layout KDL 文件
pub fn remove_session_layout(session_name: &str) {
    let path = session_layout_dir().join(format!("{}.kdl", session_name));
    let _ = fs::remove_file(path);
}

/// KDL 字符串转义
fn escape_kdl(s: &str) -> String {
    s.replace('\\', "\\\\").replace('"', "\\\"")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_generate_kdl_single() {
        let kdl = generate_kdl(&TaskLayout::Single, "", None);
        assert!(kdl.contains("pane"));
    }

    #[test]
    fn test_generate_kdl_agent_shell() {
        let kdl = generate_kdl(&TaskLayout::AgentShell, "claude", None);
        assert!(kdl.contains("split_direction"));
        assert!(kdl.contains("claude"));
        assert!(kdl.contains("60%"));
        assert!(kdl.contains("40%"));
    }

    #[test]
    fn test_generate_kdl_agent_monitor() {
        let kdl = generate_kdl(&TaskLayout::AgentMonitor, "claude --yolo", None);
        assert!(kdl.contains("split_direction"));
        assert!(kdl.contains("grove"));
        assert!(kdl.contains("claude --yolo"));
    }

    #[test]
    fn test_escape_kdl() {
        assert_eq!(escape_kdl(r#"hello "world""#), r#"hello \"world\""#);
        assert_eq!(escape_kdl(r"back\slash"), r"back\\slash");
    }
}

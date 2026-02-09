//! Zellij KDL layout 生成

use std::fs;
use std::path::PathBuf;

use crate::error::{GroveError, Result};
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
///
/// `env_prefix`: shell export 前缀（如 `export GROVE_TASK_ID='val'; `），
/// 会注入到每个 pane 的命令中以确保环境变量可用。
pub fn generate_kdl(
    layout: &TaskLayout,
    agent_command: &str,
    custom_layout: Option<&CustomLayout>,
    env_prefix: &str,
) -> String {
    match layout {
        TaskLayout::Single => {
            format!("layout {{\n{}\n}}\n", shell_pane("    ", "", env_prefix))
        }
        TaskLayout::Agent => {
            if agent_command.is_empty() {
                format!("layout {{\n{}\n}}\n", shell_pane("    ", "", env_prefix))
            } else {
                format!(
                    "layout {{\n{}\n}}\n",
                    cmd_pane("    ", "", agent_command, env_prefix)
                )
            }
        }
        TaskLayout::AgentShell => {
            let agent = if agent_command.is_empty() {
                shell_pane("        ", "size=\"60%\" ", env_prefix)
            } else {
                cmd_pane("        ", "size=\"60%\" ", agent_command, env_prefix)
            };
            let shell = shell_pane("        ", "size=\"40%\" ", env_prefix);
            format!(
                "layout {{\n    pane split_direction=\"vertical\" {{\n{}\n{}\n    }}\n}}\n",
                agent, shell
            )
        }
        TaskLayout::AgentMonitor => {
            let agent = if agent_command.is_empty() {
                shell_pane("        ", "size=\"60%\" ", env_prefix)
            } else {
                cmd_pane("        ", "size=\"60%\" ", agent_command, env_prefix)
            };
            let grove = cmd_pane("            ", "size=\"60%\" ", "grove", env_prefix);
            let shell = shell_pane("            ", "size=\"40%\" ", env_prefix);
            format!(
                "layout {{\n    pane split_direction=\"vertical\" {{\n{}\n        pane size=\"40%\" split_direction=\"horizontal\" {{\n{}\n{}\n        }}\n    }}\n}}\n",
                agent, grove, shell
            )
        }
        TaskLayout::GroveAgent => {
            let grove = cmd_pane("        ", "size=\"40%\" ", "grove", env_prefix);
            let agent = if agent_command.is_empty() {
                shell_pane("        ", "size=\"60%\" ", env_prefix)
            } else {
                cmd_pane("        ", "size=\"60%\" ", agent_command, env_prefix)
            };
            format!(
                "layout {{\n    pane split_direction=\"vertical\" {{\n{}\n{}\n    }}\n}}\n",
                grove, agent
            )
        }
        TaskLayout::Custom => {
            if let Some(cl) = custom_layout {
                let mut buf = String::new();
                buf.push_str("layout {\n");
                generate_node_kdl(&cl.root, agent_command, env_prefix, &mut buf, 1);
                buf.push_str("}\n");
                buf
            } else {
                format!("layout {{\n{}\n}}\n", shell_pane("    ", "", env_prefix))
            }
        }
    }
}

/// 生成 shell pane（带 env export + exec $SHELL）
fn shell_pane(indent: &str, attrs: &str, env_prefix: &str) -> String {
    if env_prefix.is_empty() {
        format!("{}pane {}", indent, attrs).trim_end().to_string()
    } else {
        format!(
            "{}pane {}command=\"sh\" {{\n{}    args \"-c\" \"{}exec ${{SHELL:-sh}}\"\n{}}}",
            indent,
            attrs,
            indent,
            escape_kdl(env_prefix),
            indent,
        )
    }
}

/// 生成 command pane（带 env prefix）
fn cmd_pane(indent: &str, attrs: &str, command: &str, env_prefix: &str) -> String {
    let full_cmd = format!("{}{}", env_prefix, command);
    format!(
        "{}pane {}command=\"sh\" {{\n{}    args \"-c\" \"{}\"\n{}}}",
        indent,
        attrs,
        indent,
        escape_kdl(&full_cmd),
        indent,
    )
}

/// 递归生成 LayoutNode 的 KDL 内容
fn generate_node_kdl(
    node: &LayoutNode,
    agent_command: &str,
    env_prefix: &str,
    buf: &mut String,
    indent: usize,
) {
    let pad = "    ".repeat(indent);
    match node {
        LayoutNode::Pane { pane } => {
            buf.push_str(&pane_kdl(pane, agent_command, env_prefix, &pad, ""));
            buf.push('\n');
        }
        LayoutNode::Split {
            dir,
            ratio,
            first,
            second,
        } => {
            let direction = match dir {
                SplitDirection::Horizontal => "vertical",
                SplitDirection::Vertical => "horizontal",
            };
            let first_pct = *ratio as u32;
            let second_pct = 100u32.saturating_sub(first_pct);
            buf.push_str(&format!(
                "{}pane split_direction=\"{}\" {{\n",
                pad, direction
            ));
            buf.push_str(&format!("{}    // size=\"{}%\"\n", pad, first_pct));
            generate_node_kdl_sized(first, agent_command, env_prefix, buf, indent + 1, first_pct);
            buf.push_str(&format!("{}    // size=\"{}%\"\n", pad, second_pct));
            generate_node_kdl_sized(
                second,
                agent_command,
                env_prefix,
                buf,
                indent + 1,
                second_pct,
            );
            buf.push_str(&format!("{}}}\n", pad));
        }
        LayoutNode::Placeholder => {
            buf.push_str(&shell_pane(&pad, "", env_prefix));
            buf.push('\n');
        }
    }
}

/// 带 size 属性的节点 KDL 生成
fn generate_node_kdl_sized(
    node: &LayoutNode,
    agent_command: &str,
    env_prefix: &str,
    buf: &mut String,
    indent: usize,
    size_pct: u32,
) {
    let pad = "    ".repeat(indent);
    let size_attr = format!("size=\"{}%\" ", size_pct);
    match node {
        LayoutNode::Pane { pane } => {
            buf.push_str(&pane_kdl(pane, agent_command, env_prefix, &pad, &size_attr));
            buf.push('\n');
        }
        LayoutNode::Split { .. } => {
            generate_node_kdl(node, agent_command, env_prefix, buf, indent);
        }
        LayoutNode::Placeholder => {
            buf.push_str(&shell_pane(&pad, &size_attr, env_prefix));
            buf.push('\n');
        }
    }
}

/// 根据 PaneRole 生成 KDL pane（统一入口）
fn pane_kdl(
    pane: &PaneRole,
    agent_command: &str,
    env_prefix: &str,
    indent: &str,
    attrs: &str,
) -> String {
    match pane {
        PaneRole::Agent => {
            if agent_command.is_empty() {
                shell_pane(indent, attrs, env_prefix)
            } else {
                cmd_pane(indent, attrs, agent_command, env_prefix)
            }
        }
        PaneRole::Grove => cmd_pane(indent, attrs, "grove", env_prefix),
        PaneRole::Shell => shell_pane(indent, attrs, env_prefix),
        PaneRole::FilePicker => cmd_pane(indent, attrs, "grove fp", env_prefix),
        PaneRole::Custom(cmd) => {
            if cmd.is_empty() {
                shell_pane(indent, attrs, env_prefix)
            } else {
                cmd_pane(indent, attrs, cmd, env_prefix)
            }
        }
    }
}

/// 写入 session layout KDL 文件
pub fn write_session_layout(session_name: &str, kdl_content: &str) -> Result<String> {
    let dir = session_layout_dir();
    let path = dir.join(format!("{}.kdl", session_name));
    fs::write(&path, kdl_content)
        .map_err(|e| GroveError::storage(format!("Failed to write layout file: {}", e)))?;
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
        let kdl = generate_kdl(&TaskLayout::Single, "", None, "");
        assert!(kdl.contains("pane"));
    }

    #[test]
    fn test_generate_kdl_agent_shell() {
        let kdl = generate_kdl(&TaskLayout::AgentShell, "claude", None, "");
        assert!(kdl.contains("split_direction"));
        assert!(kdl.contains("claude"));
        assert!(kdl.contains("60%"));
        assert!(kdl.contains("40%"));
    }

    #[test]
    fn test_generate_kdl_agent_monitor() {
        let kdl = generate_kdl(&TaskLayout::AgentMonitor, "claude --yolo", None, "");
        assert!(kdl.contains("split_direction"));
        assert!(kdl.contains("grove"));
        assert!(kdl.contains("claude --yolo"));
    }

    #[test]
    fn test_generate_kdl_with_env_prefix() {
        let env_prefix = "export GROVE_TASK_ID='test'; ";
        let kdl = generate_kdl(&TaskLayout::Single, "", None, env_prefix);
        assert!(kdl.contains("GROVE_TASK_ID"));
        assert!(kdl.contains("exec ${SHELL:-sh}"));
    }

    #[test]
    fn test_generate_kdl_agent_with_env() {
        let env_prefix = "export GROVE_TASK_ID='t1'; ";
        let kdl = generate_kdl(&TaskLayout::AgentShell, "claude", None, env_prefix);
        assert!(kdl.contains("GROVE_TASK_ID='t1'; claude"));
        assert!(kdl.contains("GROVE_TASK_ID='t1'; exec ${SHELL:-sh}"));
    }

    #[test]
    fn test_escape_kdl() {
        assert_eq!(escape_kdl(r#"hello "world""#), r#"hello \"world\""#);
        assert_eq!(escape_kdl(r"back\slash"), r"back\\slash");
    }
}

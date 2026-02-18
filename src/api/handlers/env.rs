//! Environment check API handlers

use axum::{extract::Path, Json};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::process::Command;

/// Dependency status
#[derive(Debug, Serialize)]
pub struct DependencyStatus {
    pub name: String,
    pub installed: bool,
    pub version: Option<String>,
    pub install_command: String,
}

/// GET /api/v1/env/check response
#[derive(Debug, Serialize)]
pub struct EnvCheckResponse {
    pub dependencies: Vec<DependencyStatus>,
}

/// Dependency definition
struct DependencyDef {
    name: &'static str,
    check_cmd: &'static str,
    check_args: &'static [&'static str],
    install_command: &'static str,
}

const DEPENDENCIES: &[DependencyDef] = &[
    DependencyDef {
        name: "git",
        check_cmd: "git",
        check_args: &["--version"],
        install_command: "brew install git",
    },
    DependencyDef {
        name: "tmux",
        check_cmd: "tmux",
        check_args: &["-V"],
        install_command: "brew install tmux",
    },
    DependencyDef {
        name: "zellij",
        check_cmd: "zellij",
        check_args: &["--version"],
        install_command: "brew install zellij",
    },
    DependencyDef {
        name: "fzf",
        check_cmd: "fzf",
        check_args: &["--version"],
        install_command: "brew install fzf",
    },
    DependencyDef {
        name: "claude-code-acp",
        check_cmd: "which",
        check_args: &["claude-code-acp"],
        install_command: "npm install -g @zed-industries/claude-code-acp",
    },
    DependencyDef {
        name: "codex-acp",
        check_cmd: "which",
        check_args: &["codex-acp"],
        install_command: "npm install -g @zed-industries/codex-acp",
    },
];

/// ACP adapter dependency names
const ACP_DEP_NAMES: &[&str] = &["claude-code-acp", "codex-acp"];

fn check_dependency(dep: &DependencyDef) -> DependencyStatus {
    // 对 tmux 和 zellij 使用 check.rs 中的函数（支持测试环境变量）
    let installed = match dep.name {
        "tmux" => crate::check::check_tmux_available(),
        "zellij" => crate::check::check_zellij_available(),
        name if ACP_DEP_NAMES.contains(&name) => {
            // 测试模式：GROVE_TEST_NO_ACP=1 模拟所有 ACP adapter 不存在
            if std::env::var("GROVE_TEST_NO_ACP").is_ok() {
                false
            } else {
                Command::new(dep.check_cmd)
                    .args(dep.check_args)
                    .output()
                    .map(|o| o.status.success())
                    .unwrap_or(false)
            }
        }
        _ => {
            // 其他依赖直接执行命令检查
            Command::new(dep.check_cmd)
                .args(dep.check_args)
                .output()
                .map(|o| o.status.success())
                .unwrap_or(false)
        }
    };

    if !installed {
        return DependencyStatus {
            name: dep.name.to_string(),
            installed: false,
            version: None,
            install_command: dep.install_command.to_string(),
        };
    }

    // 已安装，获取版本信息
    let result = Command::new(dep.check_cmd).args(dep.check_args).output();
    match result {
        Ok(output) if output.status.success() => {
            let version_str = String::from_utf8_lossy(&output.stdout);
            let version = parse_version(dep.name, version_str.trim());
            DependencyStatus {
                name: dep.name.to_string(),
                installed: true,
                version: Some(version),
                install_command: dep.install_command.to_string(),
            }
        }
        _ => DependencyStatus {
            name: dep.name.to_string(),
            installed: true,
            version: None,
            install_command: dep.install_command.to_string(),
        },
    }
}

fn parse_version(name: &str, output: &str) -> String {
    match name {
        "git" => {
            // "git version 2.43.0" -> "2.43.0"
            output
                .strip_prefix("git version ")
                .unwrap_or(output)
                .split_whitespace()
                .next()
                .unwrap_or(output)
                .to_string()
        }
        "tmux" => {
            // "tmux 3.4" -> "3.4"
            output
                .strip_prefix("tmux ")
                .unwrap_or(output)
                .split_whitespace()
                .next()
                .unwrap_or(output)
                .to_string()
        }
        "fzf" => {
            // "0.46.1 (brew)" -> "0.46.1"
            output
                .split_whitespace()
                .next()
                .unwrap_or(output)
                .to_string()
        }
        "zellij" => {
            // "zellij 0.40.1" -> "0.40.1"
            output
                .strip_prefix("zellij ")
                .unwrap_or(output)
                .split_whitespace()
                .next()
                .unwrap_or(output)
                .to_string()
        }
        "claude-code-acp" | "codex-acp" => {
            // `which` returns path, not version — just confirm installed
            "installed".to_string()
        }
        _ => output.to_string(),
    }
}

/// GET /api/v1/env/check - Check all dependencies
pub async fn check_all() -> Json<EnvCheckResponse> {
    let dependencies: Vec<DependencyStatus> = DEPENDENCIES.iter().map(check_dependency).collect();

    Json(EnvCheckResponse { dependencies })
}

/// GET /api/v1/env/check/:name - Check single dependency
pub async fn check_one(Path(name): Path<String>) -> Json<Option<DependencyStatus>> {
    let dep = DEPENDENCIES.iter().find(|d| d.name == name);

    Json(dep.map(check_dependency))
}

/// POST /api/v1/env/check-commands — batch check if commands exist on PATH
#[derive(Deserialize)]
pub struct CheckCommandsRequest {
    pub commands: Vec<String>,
}

#[derive(Serialize)]
pub struct CheckCommandsResponse {
    pub results: HashMap<String, bool>,
}

/// Known ACP agent commands — forced to false when GROVE_TEST_NO_ACP=1
const ACP_AGENT_COMMANDS: &[&str] = &[
    "claude-code-acp",
    "codex-acp",
    "gemini",
    "copilot",
    "opencode",
    "qwen",
    "kimi",
    "traecli",
];

pub async fn check_commands(Json(body): Json<CheckCommandsRequest>) -> Json<CheckCommandsResponse> {
    let test_no_acp = std::env::var("GROVE_TEST_NO_ACP").is_ok();

    let results: HashMap<String, bool> = body
        .commands
        .iter()
        .map(|cmd| {
            // 测试模式：GROVE_TEST_NO_ACP=1 模拟所有 ACP agent 命令不存在
            if test_no_acp && ACP_AGENT_COMMANDS.contains(&cmd.as_str()) {
                return (cmd.clone(), false);
            }
            let exists = Command::new("which")
                .arg(cmd)
                .output()
                .map(|o| o.status.success())
                .unwrap_or(false);
            (cmd.clone(), exists)
        })
        .collect();

    Json(CheckCommandsResponse { results })
}

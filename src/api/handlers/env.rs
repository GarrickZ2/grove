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

// 这个 endpoint 只服务 grove-web,而 grove-web 只消费 tmux + zellij 状态
// (用来判断 terminal multiplexer 是否可用)。git 通过功能调用失败暴露,
// fzf 仅 `grove fp` CLI 命令使用,d2 在 Preview 渲染时另起检查 ——
// 都不需要走这个 HTTP 接口。
#[cfg(target_os = "linux")]
const TMUX_INSTALL_CMD: &str = "sudo apt install tmux  # or: dnf install tmux / pacman -S tmux";
#[cfg(not(any(target_os = "windows", target_os = "linux")))]
const TMUX_INSTALL_CMD: &str = "brew install tmux";

#[cfg(target_os = "linux")]
const ZELLIJ_INSTALL_CMD: &str = "cargo install zellij  # or: snap install zellij";
#[cfg(not(any(target_os = "windows", target_os = "linux")))]
const ZELLIJ_INSTALL_CMD: &str = "brew install zellij";

// D2 install hint — used by render.rs when D2 is missing during preview render.
#[cfg(target_os = "windows")]
pub const D2_INSTALL_CMD: &str = "winget install Terrastruct.D2";
#[cfg(target_os = "linux")]
pub const D2_INSTALL_CMD: &str = "curl -fsSL https://d2lang.com/install.sh | sh -s --";
#[cfg(not(any(target_os = "windows", target_os = "linux")))]
pub const D2_INSTALL_CMD: &str = "brew install d2";

/// Dependencies that grove-web actually consumes. Windows is left empty
/// since neither tmux nor zellij is natively supported there.
#[cfg(not(target_os = "windows"))]
const ALL_DEPENDENCIES: &[DependencyDef] = &[
    DependencyDef {
        name: "tmux",
        check_cmd: "tmux",
        check_args: &["-V"],
        install_command: TMUX_INSTALL_CMD,
    },
    DependencyDef {
        name: "zellij",
        check_cmd: "zellij",
        check_args: &["--version"],
        install_command: ZELLIJ_INSTALL_CMD,
    },
];

#[cfg(target_os = "windows")]
const ALL_DEPENDENCIES: &[DependencyDef] = &[];

fn current_dependencies() -> &'static [DependencyDef] {
    ALL_DEPENDENCIES
}

fn check_dependency(dep: &DependencyDef) -> DependencyStatus {
    // tmux / zellij 用 check.rs 中的函数支持 GROVE_TEST_NO_* 环境变量
    let test_overrides = match dep.name {
        "tmux" if !crate::check::check_tmux_available() => Some(false),
        "zellij" if !crate::check::check_zellij_available() => Some(false),
        _ => None,
    };
    if test_overrides == Some(false) {
        return DependencyStatus {
            name: dep.name.to_string(),
            installed: false,
            version: None,
            install_command: dep.install_command.to_string(),
        };
    }

    // 其他依赖：单次 spawn 同时获取 installed + 版本，避免在 Windows 上重复进程开销。
    match Command::new(dep.check_cmd).args(dep.check_args).output() {
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
        Ok(_) => DependencyStatus {
            // 命令存在但退出非 0：仍然算已安装，只是拿不到版本
            name: dep.name.to_string(),
            installed: true,
            version: None,
            install_command: dep.install_command.to_string(),
        },
        Err(_) => DependencyStatus {
            name: dep.name.to_string(),
            installed: false,
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
        "claude-agent-acp" | "claude-code-acp" | "codex-acp" => {
            // ACP adapters cannot be probed for a version (they enter stdio mode);
            // the `installed` value here is provided by check_dependency directly.
            "installed".to_string()
        }
        "d2" => {
            // "v0.6.8" or "v0.6.8 (linux-amd64)" → "0.6.8"
            output
                .trim_start_matches('v')
                .split_whitespace()
                .next()
                .unwrap_or(output)
                .to_string()
        }
        _ => output.to_string(),
    }
}

/// GET /api/v1/env/check - Check all dependencies
pub async fn check_all() -> Json<EnvCheckResponse> {
    use rayon::prelude::*;

    // Sync `Command::output()` per dep — push off the tokio runtime and
    // run them in parallel so cold spawns don't add up.
    let dependencies = tokio::task::spawn_blocking(|| {
        current_dependencies()
            .par_iter()
            .map(check_dependency)
            .collect::<Vec<_>>()
    })
    .await
    .unwrap_or_default();

    Json(EnvCheckResponse { dependencies })
}

/// GET /api/v1/env/check/:name - Check single dependency
pub async fn check_one(Path(name): Path<String>) -> Json<Option<DependencyStatus>> {
    let dep = current_dependencies().iter().find(|d| d.name == name);

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
    "claude-agent-acp",
    "claude-code-acp",
    "codex-acp",
    "npx",
    "gemini",
    "copilot",
    "opencode",
    "qwen",
    "kimi",
    "traecli",
    "cursor-agent",
    "agent",
    "junie",
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
            let exists = crate::check::command_exists(cmd);
            (cmd.clone(), exists)
        })
        .collect();

    Json(CheckCommandsResponse { results })
}

//! Environment check API handlers

use axum::{extract::Path, Json};
use serde::Serialize;
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
        name: "fzf",
        check_cmd: "fzf",
        check_args: &["--version"],
        install_command: "brew install fzf",
    },
    DependencyDef {
        name: "npx",
        check_cmd: "npx",
        check_args: &["--version"],
        install_command: "brew install node",
    },
];

fn check_dependency(dep: &DependencyDef) -> DependencyStatus {
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
        "npx" => {
            // "10.2.4" -> "10.2.4"
            output.trim().to_string()
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

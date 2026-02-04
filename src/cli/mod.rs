//! CLI 模块

pub mod fp;
pub mod hooks;
pub mod mcp;

use clap::{Parser, Subcommand};

#[derive(Parser)]
#[command(name = "grove")]
#[command(version)]
#[command(about = "Git Worktree + tmux manager")]
pub struct Cli {
    #[command(subcommand)]
    pub command: Option<Commands>,
}

#[derive(Subcommand)]
pub enum Commands {
    /// Send hook notifications
    Hooks {
        #[command(subcommand)]
        level: hooks::HookLevel,
    },
    /// Start MCP server (stdio transport) for AI integration
    Mcp,
    /// Interactive file picker using fzf
    Fp,
}

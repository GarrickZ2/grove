//! CLI 模块

pub mod agent;
pub mod hooks;
pub mod init;

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
    /// AI agent commands (status, summary, todo, notes)
    Agent {
        #[command(subcommand)]
        command: agent::AgentCommands,
    },
}

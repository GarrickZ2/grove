//! CLI 模块

pub mod hooks;

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
}

//! CLI 模块

pub mod fp;
pub mod hooks;
pub mod mcp;
pub mod web;

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
    /// Start the web UI server (API + frontend)
    Web {
        /// Port to listen on
        #[arg(short, long, default_value_t = web::DEFAULT_PORT)]
        port: u16,
        /// Don't automatically open browser
        #[arg(long)]
        no_open: bool,
        /// Development mode (run Vite dev server with HMR)
        #[arg(long)]
        dev: bool,
    },
}

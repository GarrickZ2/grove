//! CLI 模块

pub mod acp;
pub mod diff;
pub mod fp;
pub mod hooks;
pub mod mcp;
pub mod migrate;
pub mod web;

#[cfg(feature = "gui")]
pub mod gui;

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
    /// Open diff review for a task in the browser
    Diff {
        /// Task ID (defaults to GROVE_TASK_ID env var)
        task_id: Option<String>,
        /// Port for the web server
        #[arg(short, long, default_value_t = web::DEFAULT_PORT)]
        port: u16,
    },
    /// Start the GUI desktop application (native window)
    Gui {
        /// Port for the internal API server
        #[arg(short, long, default_value_t = 3001)]
        port: u16,
    },
    /// Start an interactive ACP chat session with an AI agent
    Acp {
        /// Agent name (e.g., "claude")
        agent: String,
        /// Working directory
        #[arg(long, default_value = ".")]
        cwd: String,
    },
    /// Migrate storage to the latest format (v1.1 with task_modes)
    Migrate {
        /// Show what would be done without making changes
        #[arg(long)]
        dry_run: bool,
    },
}

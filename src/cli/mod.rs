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
use std::net::IpAddr;

use crate::storage::config::LastLaunch;

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
    /// Launch the terminal UI (same as running 'grove' with no arguments)
    Tui,
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
        /// Host to bind to
        #[arg(long, default_value = "127.0.0.1")]
        host: IpAddr,
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
    /// Start the mobile-friendly web server (LAN-accessible with HMAC-SHA256 auth)
    Mobile {
        /// Port to listen on
        #[arg(short, long, default_value_t = web::DEFAULT_PORT)]
        port: u16,
        /// Don't automatically open browser
        #[arg(long)]
        no_open: bool,
        /// Enable TLS (auto-generates self-signed cert if --cert/--key not provided)
        #[arg(long)]
        tls: bool,
        /// Path to TLS certificate file (PEM). Implies --tls
        #[arg(long, requires = "key")]
        cert: Option<String>,
        /// Path to TLS private key file (PEM). Implies --tls
        #[arg(long, requires = "cert")]
        key: Option<String>,
        /// Bind to a specific host address (default: auto-detected LAN IP)
        #[arg(long)]
        host: Option<String>,
        /// Bind to 0.0.0.0 (all interfaces)
        #[arg(long)]
        public: bool,
    },
    /// Migrate storage to the latest format (v1.1 with task_modes)
    Migrate {
        /// Show what would be done without making changes
        #[arg(long)]
        dry_run: bool,
    },
}

impl Commands {
    /// 将启动模式命令转换为 `LastLaunch`（非启动模式命令返回 None）
    pub fn to_last_launch(&self) -> Option<LastLaunch> {
        match self {
            Commands::Tui => Some(LastLaunch::Tui),
            Commands::Web { port, no_open, dev, .. } => Some(LastLaunch::Web {
                port: *port,
                no_open: *no_open,
                dev: *dev,
            }),
            Commands::Mobile {
                port,
                no_open,
                tls,
                cert,
                key,
                host,
                public,
            } => Some(LastLaunch::Mobile {
                port: *port,
                no_open: *no_open,
                tls: *tls,
                cert: cert.clone(),
                key: key.clone(),
                host: host.clone(),
                public: *public,
            }),
            Commands::Gui { port } => Some(LastLaunch::Gui { port: *port }),
            _ => None,
        }
    }
}

impl LastLaunch {
    /// 将 `LastLaunch` 转换回 `Commands` 以便统一调度
    pub fn to_command(&self) -> Commands {
        match self {
            LastLaunch::Tui => Commands::Tui,
            LastLaunch::Web { port, no_open, dev } => Commands::Web {
                port: *port,
                host: "127.0.0.1".parse().unwrap(),
                no_open: *no_open,
                dev: *dev,
            },
            LastLaunch::Mobile {
                port,
                no_open,
                tls,
                cert,
                key,
                host,
                public,
            } => Commands::Mobile {
                port: *port,
                no_open: *no_open,
                tls: *tls,
                cert: cert.clone(),
                key: key.clone(),
                host: host.clone(),
                public: *public,
            },
            LastLaunch::Gui { port } => Commands::Gui { port: *port },
        }
    }
}

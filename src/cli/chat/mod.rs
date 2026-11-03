//! `grove cli` — talk to agents from the terminal.
//!
//! The CLI is a thin client of a Grove server (local, auto-started headless
//! when needed, or `--remote`). Sessions live in the server, so the same chat
//! is visible from Web, GUI, Mobile, Radio, the TUI and here.

mod api;
mod ask;
mod commands;
mod conn;
mod form;
mod input;
mod model;
pub(crate) mod render;
mod repl;
pub(crate) mod screens;
mod sidebar;
mod wire;

use clap::{Args, Subcommand};

use api::{Chat, ProjectDetail};
use conn::{Conn, ConnError};

#[derive(Args, Debug, Clone, Default)]
pub struct TargetArgs {
    /// Connect to a remote Grove server (e.g. http://devbox.lan:3001), signing
    /// in with its passkey the same way Mobile does.
    #[arg(long, global = true, value_name = "URL")]
    pub remote: Option<String>,
    /// Project id or path (default: the project containing the current directory)
    #[arg(long, global = true)]
    pub project: Option<String>,
    /// Task id (default: the project's Local Task)
    #[arg(long, global = true)]
    pub task: Option<String>,
    /// Chat id to open
    #[arg(long, global = true)]
    pub chat: Option<String>,
}

#[derive(Args, Debug, Clone, Default)]
pub struct CliArgs {
    #[command(flatten)]
    pub target: TargetArgs,
    /// Start a new session instead of resuming the latest one
    #[arg(long, global = true)]
    pub new: bool,
    /// Agent for a new session (see `grove cli agents`)
    #[arg(long, global = true)]
    pub agent: Option<String>,
    #[command(subcommand)]
    pub command: Option<CliCommand>,
}

#[derive(Subcommand, Debug, Clone)]
pub enum CliCommand {
    /// List sessions in the project
    Ls {
        /// Print JSON
        #[arg(long)]
        json: bool,
    },
    /// Create a new session and print its id
    New {
        #[arg(long)]
        title: Option<String>,
        #[arg(long)]
        json: bool,
    },
    /// Send a message to a session
    Send {
        /// Message text (reads stdin when omitted)
        #[arg(short, long)]
        message: Option<String>,
        /// Wait for the agent to finish and print its reply
        #[arg(long)]
        wait: bool,
        /// With --wait, print the reply as JSON
        #[arg(long)]
        json: bool,
    },
    /// Print a session's transcript
    Log {
        /// Chat id (default: the latest session)
        chat_id: Option<String>,
        /// Keep streaming while the session is live
        #[arg(long)]
        follow: bool,
        /// Print the raw events as JSON
        #[arg(long)]
        json: bool,
    },
    /// List agents installed on the server
    Agents {
        #[arg(long)]
        json: bool,
    },
}

/// What the CLI is talking to.
#[derive(Clone)]
pub struct Target {
    pub project: ProjectDetail,
    pub task_id: String,
    pub chat: Chat,
}

impl Target {
    pub fn chat_path(&self) -> String {
        api::chat_path(&self.project.id, &self.task_id, &self.chat.id)
    }

    pub fn task_name(&self) -> String {
        self.project.task_name(&self.task_id)
    }
}

pub fn fail(message: impl std::fmt::Display) -> ! {
    eprintln!("grove cli: {message}");
    std::process::exit(1);
}

async fn connect(target: &TargetArgs) -> Conn {
    let result = match &target.remote {
        Some(url) => conn::connect_remote(url).await,
        None => conn::connect_local().await,
    };
    let mut conn = result.unwrap_or_else(|e| fail(e));
    if let Err(e) = conn.ensure_authorized().await {
        fail(e);
    }
    conn
}

/// Resolve `--project`, then `$GROVE_PROJECT` (set inside Grove task
/// sessions), then the current directory. A local git repo that is not yet
/// registered is added, like `grove` does on startup.
pub async fn resolve_project(
    conn: &Conn,
    args: &TargetArgs,
) -> Result<Option<ProjectDetail>, ConnError> {
    let projects = api::projects(conn).await?;
    if let Some(wanted) = &args.project {
        let by_id = projects
            .iter()
            .find(|p| &p.id == wanted || &p.name == wanted);
        let by_path = || api::project_for_dir(&projects, std::path::Path::new(wanted));
        return match by_id.or_else(by_path) {
            Some(project) => Ok(Some(api::project(conn, &project.id).await?)),
            None => Err(ConnError::Other(format!("No project matches '{wanted}'"))),
        };
    }
    let env_dir = std::env::var("GROVE_PROJECT")
        .ok()
        .filter(|p| !p.is_empty());
    let dir = env_dir
        .map(std::path::PathBuf::from)
        .or_else(|| std::env::current_dir().ok());
    let Some(dir) = dir else { return Ok(None) };
    if let Some(project) = api::project_for_dir(&projects, &dir) {
        return Ok(Some(api::project(conn, &project.id).await?));
    }
    if !conn.remote {
        if let Some(root) = crate::git::repo_root(&dir.to_string_lossy())
            .ok()
            .filter(|r| !r.is_empty())
        {
            let added = api::add_project(conn, &root).await?;
            return Ok(Some(api::project(conn, &added.id).await?));
        }
    }
    Ok(None)
}

pub fn default_task(args: &TargetArgs) -> String {
    args.task
        .clone()
        .or_else(|| {
            std::env::var("GROVE_TASK_ID")
                .ok()
                .filter(|t| !t.is_empty())
        })
        .unwrap_or_else(|| api::LOCAL_TASK_ID.to_string())
}

/// Pick the chat to open: `--chat`, else the latest Grove-native session
/// (unless `new`), else a fresh one with `agent`.
pub async fn resolve_chat(
    conn: &Conn,
    project: &ProjectDetail,
    task_id: &str,
    chat_id: Option<&str>,
    new: bool,
    agent: Option<&str>,
) -> Result<Chat, ConnError> {
    let chats = api::chats(conn, &project.id, task_id).await?;
    if let Some(id) = chat_id {
        return chats
            .into_iter()
            .find(|chat| chat.id == id)
            .ok_or_else(|| ConnError::Other(format!("No chat '{id}' in this task")));
    }
    if !new {
        let latest = chats
            .into_iter()
            .max_by(|a, b| a.last_active().cmp(b.last_active()));
        if let Some(chat) = latest {
            return Ok(chat);
        }
    }
    api::create_chat(conn, &project.id, task_id, agent, None).await
}

/// The remote this machine signed in to last, to suggest it again.
pub fn last_remote() -> Option<String> {
    conn::last_remote()
}

/// Grove's terminal app (`grove`, `grove tui`): the sidebar and the chat.
pub async fn run_app(remote: Option<String>) {
    let mut args = CliArgs::default();
    args.target.remote = remote;
    execute(args).await
}

pub async fn execute(args: CliArgs) {
    let conn = connect(&args.target).await;
    match args.command.clone() {
        None => repl::run(conn, args).await,
        Some(command) => commands::run(conn, &args, command).await,
    }
}

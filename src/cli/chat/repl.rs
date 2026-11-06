//! Interactive `grove cli`: a full-screen terminal app.
//!
//! The conversation scrolls in the upper part of the screen (mouse wheel,
//! PgUp / PgDn); the input box and status line stay pinned to the bottom.
//! The slash menu, a permission request and the agent's questions float just
//! above the input. The start page, the target switcher and the agent panel
//! take the whole screen (see `screens`).

use std::collections::HashMap;
use std::io::Stdout;
use std::time::{Duration, Instant};

use crossterm::event::{
    self, DisableBracketedPaste, DisableMouseCapture, EnableBracketedPaste, EnableMouseCapture,
    Event, KeyCode, KeyEvent, KeyEventKind, KeyModifiers, MouseEventKind,
};
use crossterm::terminal::{EnterAlternateScreen, LeaveAlternateScreen};
use futures::{SinkExt, StreamExt};
use ratatui::backend::CrosstermBackend;
use ratatui::layout::Rect;
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block as Frame, BorderType, Borders, Paragraph, Widget};
use ratatui::Terminal;
use serde_json::{json, Value};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;

use super::ask::{self, Draft};
use super::conn::Conn;
use super::form::{Form, Kind, Source};
use super::input::Input;
use super::model::{Block, Level, Session};
use super::render::{self, Palette};
use super::screens::{self, Action, AgentPanel, PageAction, ProjectsPage, Screen};
use super::sidebar::{self, Action as SideAction, Prompt as SidePrompt, Sidebar};
use super::{api, fail, wire, CliArgs, Target};
use crate::theme::Theme;

const MENU_ROWS: usize = 10;

enum AppEvent {
    Key(KeyEvent),
    Paste(String),
    Resize,
    /// Wheel: lines, at a column.
    Scroll(i32, u16),
    Click(u16, u16),
    Server {
        generation: u64,
        value: Value,
    },
    Closed {
        generation: u64,
    },
    /// Try the server again after the chat socket dropped.
    Reconnect {
        generation: u64,
    },
    Sidebar(Box<SidebarData>),
    Tick,
}

/// A fresh look at the sidebar's project, loaded in the background.
struct SidebarData {
    project: api::ProjectDetail,
    projects: Vec<api::Project>,
    sessions: HashMap<String, Vec<api::Chat>>,
    active: HashMap<String, String>,
    buddies: Vec<api::Buddy>,
}

/// Grove's slash commands: (name, what it does, key, group).
const COMMANDS: &[(&str, &str, &str, &str)] = &[
    (
        "/new",
        "Start a new session — choose its agent",
        "⌃N",
        "Session",
    ),
    (
        "/sessions",
        "Browse sessions in the sidebar",
        "⌃B",
        "Session",
    ),
    ("/projects", "All projects and Buddies", "", "Session"),
    ("/agent", "Agent, model, mode and thinking", "", "Agent"),
    ("/model", "Change the model", "", "Agent"),
    ("/mode", "Change the agent's mode", "", "Agent"),
    ("/effort", "Change how hard the agent thinks", "", "Agent"),
    ("/queue", "Remove a queued message", "⌃Q", "Agent"),
    ("/cancel", "Interrupt the agent", "esc", "Agent"),
    (
        "/retry-auth",
        "Retry after signing the agent in",
        "",
        "Agent",
    ),
    ("/info", "Project, task and session details", "", "View"),
    (
        "/theme",
        "Change the theme (shared with the GUI)",
        "",
        "View",
    ),
    ("/shell", "A shell in this task's directory", "⌃G", "View"),
    ("/plan", "Show the agent's latest plan", "", "View"),
    ("/verbose", "Full tool output and thinking", "⌃O", "View"),
    ("/help", "Keys and tips", "", "View"),
    ("/quit", "Leave — the session keeps running", "⌃D", "View"),
];

/// A row of the `/` menu.
struct MenuItem {
    name: String,
    about: String,
    keys: String,
    group: &'static str,
    /// The agent's own command (sent as a prompt).
    agent: bool,
}

/// Queued messages, removable one by one.
struct QueuePicker {
    selected: usize,
}

/// One piece of the conversation as shown.
enum Item {
    Block(Block),
    Lines(Vec<Line<'static>>),
}

/// Finished conversation, rendered once per width / verbosity.
#[derive(Default)]
struct Transcript {
    items: Vec<Item>,
    lines: Vec<Line<'static>>,
    key: Option<(usize, bool)>,
}

impl Transcript {
    fn render(item: &Item, width: usize, p: &Palette, verbose: bool) -> Vec<Line<'static>> {
        match item {
            Item::Block(block) => render::block(block, width, p, 0, verbose),
            Item::Lines(lines) => lines.clone(),
        }
    }

    fn push(&mut self, item: Item, p: &Palette) {
        if let Some((width, verbose)) = self.key {
            self.lines.extend(Self::render(&item, width, p, verbose));
        }
        self.items.push(item);
    }

    fn lines(&mut self, width: usize, verbose: bool, p: &Palette) -> &[Line<'static>] {
        if self.key != Some((width, verbose)) {
            self.key = Some((width, verbose));
            self.lines = self
                .items
                .iter()
                .flat_map(|item| Self::render(item, width, p, verbose))
                .collect();
        }
        &self.lines
    }
}

struct App {
    conn: Conn,
    palette: Palette,
    target: Target,
    session: Session,
    /// Blocks of `session` already moved into the transcript.
    flushed: usize,
    transcript: Transcript,
    /// First transcript line shown, or `None` to follow the bottom.
    scroll_top: Option<usize>,
    /// Lines the conversation area held at the last draw.
    view_height: usize,
    view_lines: usize,
    input: Input,
    screen: Option<Screen>,
    queue_picker: Option<QueuePicker>,
    /// Highlighted option of the open permission request: (request id, row).
    permission_row: (String, usize),
    /// Progress through the agent's first open question form.
    draft: Option<Draft>,
    menu_selected: usize,
    verbose: bool,
    quit_armed: Option<Instant>,
    flash: Option<(String, Instant)>,
    pending_config: Option<Value>,
    frame: usize,
    generation: u64,
    out: Option<mpsc::UnboundedSender<Value>>,
    reader: Option<tokio::task::JoinHandle<()>>,
    events: mpsc::UnboundedSender<AppEvent>,
    quit: bool,
    /// Agent id → display name ("codex-acp" → "Codex").
    agent_names: HashMap<String, String>,
    /// Reconnect attempts since the chat socket dropped; `None` while
    /// connected (or before any session is open).
    reconnecting: Option<u32>,
    /// A message typed before the session could take it (a new session, or
    /// while reconnecting); sent once the agent is ready.
    pending_prompt: Option<String>,
    sidebar: Sidebar,
    /// The Buddy this conversation is with, when it is one.
    buddy: Option<String>,
    /// Where the sidebar was drawn (zero width when hidden), for clicks.
    sidebar_area: Rect,
    /// The theme list, previewing as it moves: (row, palette to restore).
    theme_picker: Option<(usize, Palette)>,
    /// A directory to open a shell in; the run loop hands it the terminal.
    shell_request: Option<String>,
}

type Term = Terminal<CrosstermBackend<Stdout>>;

fn spinner(frame: usize) -> &'static str {
    const FRAMES: [&str; 10] = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
    FRAMES[frame % FRAMES.len()]
}

impl App {
    fn flash(&mut self, text: impl Into<String>) {
        self.flash = Some((text.into(), Instant::now()));
    }

    fn print(&mut self, lines: Vec<Line<'static>>) {
        self.transcript.push(Item::Lines(lines), &self.palette);
    }

    fn notice(&mut self, level: Level, text: impl Into<String>) {
        self.transcript.push(
            Item::Block(Block::Notice {
                level,
                text: text.into(),
            }),
            &self.palette,
        );
    }

    /// A message's sender as people know it: `buddy:<id>` → the Buddy's name.
    fn sender_name(&self, sender: &str) -> String {
        sender
            .strip_prefix("buddy:")
            .and_then(|id| self.sidebar.buddies.iter().find(|b| b.id == id))
            .map(|buddy| format!("◈ {}", buddy.name))
            .unwrap_or_else(|| sender.to_string())
    }

    /// Move every settled leading block into the transcript.
    fn flush(&mut self) {
        while self.flushed < self.session.blocks.len() && self.session.settled(self.flushed) {
            let mut block = self.session.blocks[self.flushed].clone();
            if let Block::User {
                sender: Some(sender),
                ..
            } = &mut block
            {
                *sender = self.sender_name(sender);
            }
            self.transcript.push(Item::Block(block), &self.palette);
            self.flushed += 1;
        }
    }

    fn send(&mut self, message: Value) {
        if let Some(out) = &self.out {
            let _ = out.send(message);
        }
    }

    /// (project id, task id) of the conversation.
    fn here(&self) -> (String, String) {
        (self.target.project.id.clone(), self.target.task_id.clone())
    }

    /// Whether a session is open (false on the start page).
    fn has_chat(&self) -> bool {
        !self.target.chat.id.is_empty()
    }

    fn agent_name(&self, id: &str) -> String {
        match self.agent_names.get(id) {
            Some(name) => name.clone(),
            // A persona's id (`ca-…`) means nothing to a person.
            None if id.starts_with("ca-") => "Custom agent".into(),
            None => id.to_string(),
        }
    }

    async fn load_agent_names(&mut self) {
        if let Ok(agents) = api::agents(&self.conn).await {
            self.agent_names = agents.into_iter().map(|a| (a.id, a.name)).collect();
        }
    }

    // ── Sessions ───────────────────────────────────────────────────────────

    /// Replay recent history, then attach to the live session.
    async fn open(&mut self, target: Target) {
        if let Some(reader) = self.reader.take() {
            reader.abort();
        }
        self.out = None;
        self.reconnecting = None;
        self.generation += 1;
        self.target = target;
        self.session = Session::default();
        self.flushed = 0;
        self.transcript = Transcript::default();
        self.scroll_top = None;
        self.pending_config = None;
        self.queue_picker = None;
        self.screen = None;
        self.buddy = None;
        self.finish_form();
        self.sidebar.here = Some((self.target.task_id.clone(), self.target.chat.id.clone()));
        if self.target.project.id == self.sidebar.project.id
            && self.target.task_id != api::LOCAL_TASK_ID
        {
            self.sidebar.expanded.insert(self.target.task_id.clone());
        }

        let p = self.palette.clone();
        self.print(vec![
            Line::from(vec![
                Span::styled(
                    self.target.chat.title.clone(),
                    p.style(p.text).add_modifier(Modifier::BOLD),
                ),
                Span::styled(
                    format!(
                        "   {} › {} · {}",
                        self.target.project.name,
                        self.target.task_name(),
                        self.agent_name(&self.target.chat.agent)
                    ),
                    p.style(p.muted),
                ),
            ]),
            Line::default(),
        ]);

        match api::history(
            &self.conn,
            &self.target.project.id,
            &self.target.task_id,
            &self.target.chat.id,
            20,
        )
        .await
        {
            Ok(history) => {
                if history.omitted_turns > 0 {
                    self.print(vec![
                        Line::from(Span::styled(
                            format!(
                                "… {} earlier turns · `grove cli log` prints them all",
                                history.omitted_turns
                            ),
                            p.style(p.faint),
                        )),
                        Line::default(),
                    ]);
                }
                for event in &history.events {
                    self.session.apply(event);
                }
                self.session.finish_replay(
                    history.runtime.active,
                    history.runtime.busy.unwrap_or(false),
                );
                self.flush();
            }
            Err(e) => self.notice(Level::Warn, format!("Could not load history: {e}")),
        }
        if !self.attach().await {
            self.start_reconnect();
        }
    }

    /// Open the chat socket and start its reader. False when it cannot.
    async fn attach(&mut self) -> bool {
        if let Some(reader) = self.reader.take() {
            reader.abort();
        }
        self.generation += 1;
        let Ok(socket) = self
            .conn
            .websocket(&format!("{}/ws", self.target.chat_path()))
            .await
        else {
            return false;
        };
        let (mut sink, mut stream) = socket.split();
        let (out_tx, mut out_rx) = mpsc::unbounded_channel::<Value>();
        let events = self.events.clone();
        let generation = self.generation;
        self.out = Some(out_tx);
        self.reader = Some(tokio::spawn(async move {
            let writer = async {
                while let Some(message) = out_rx.recv().await {
                    if sink
                        .send(Message::Text(message.to_string().into()))
                        .await
                        .is_err()
                    {
                        break;
                    }
                }
            };
            let reader = async {
                while let Some(frame) = stream.next().await {
                    match frame {
                        Ok(Message::Text(text)) => {
                            if let Ok(value) = serde_json::from_str(&text) {
                                let _ = events.send(AppEvent::Server { generation, value });
                            }
                        }
                        Ok(Message::Close(_)) | Err(_) => break,
                        _ => {}
                    }
                }
            };
            tokio::select! {
                _ = writer => {},
                _ = reader => {},
            }
            let _ = events.send(AppEvent::Closed { generation });
        }));
        true
    }

    /// The socket dropped (server restarted, GUI closed, network): keep
    /// trying in the background, starting a local server when none is left.
    fn start_reconnect(&mut self) {
        self.out = None;
        if self.reconnecting.is_none() {
            self.reconnecting = Some(0);
            self.session.busy = false;
            self.session.permission = None;
            self.notice(
                Level::Warn,
                "Lost the connection to the Grove server — reconnecting…",
            );
        }
        self.schedule_reconnect();
    }

    fn schedule_reconnect(&mut self) {
        let attempt = self.reconnecting.unwrap_or(0);
        let delay = Duration::from_millis((500 * u64::from(attempt + 1)).min(5000));
        let events = self.events.clone();
        let generation = self.generation;
        tokio::spawn(async move {
            tokio::time::sleep(delay).await;
            let _ = events.send(AppEvent::Reconnect { generation });
        });
    }

    async fn reconnect(&mut self) {
        let Some(attempt) = self.reconnecting else {
            return;
        };
        self.reconnecting = Some(attempt + 1);
        if !self.conn.remote {
            // Find the server again — it may come back on another port. Only
            // after ~10s without one start a background server, so a GUI that
            // is just restarting gets its port back.
            let spawn = attempt >= 6;
            match super::conn::connect_local_with(false, spawn).await {
                Ok(conn) => self.conn = conn,
                Err(_) => return self.schedule_reconnect(),
            }
        }
        if !self.attach().await {
            return self.schedule_reconnect();
        }
        self.reconnecting = None;
        // A restarted agent announces itself again; keep the transcript.
        self.session.ready = false;
        self.notice(Level::Info, "Reconnected.");
    }

    /// Start a session in `project` › `task` and open it.
    async fn new_session(&mut self, project_id: &str, task_id: &str, agent: Option<&str>) {
        let project = match api::project(&self.conn, project_id).await {
            Ok(project) => project,
            Err(e) => return self.flash(format!("{e}")),
        };
        match api::create_chat(&self.conn, project_id, task_id, agent, None).await {
            Ok(chat) => {
                self.open(Target {
                    project,
                    task_id: task_id.to_string(),
                    chat,
                })
                .await
            }
            Err(e) => self.flash(format!("Could not start a session: {e}")),
        }
    }

    async fn open_chat(&mut self, project_id: &str, task_id: &str, chat_id: &str) {
        if chat_id == self.target.chat.id {
            self.screen = None;
            return;
        }
        let project = match api::project(&self.conn, project_id).await {
            Ok(project) => project,
            Err(e) => return self.flash(format!("{e}")),
        };
        match super::resolve_chat(&self.conn, &project, task_id, Some(chat_id), false, None).await {
            Ok(chat) => {
                self.open(Target {
                    project,
                    task_id: task_id.to_string(),
                    chat,
                })
                .await
            }
            Err(e) => self.flash(format!("{e}")),
        }
    }

    async fn submit(&mut self) {
        let text = self.input.take();
        let trimmed = text.trim().to_string();
        if trimmed.is_empty() {
            return;
        }
        if !self.has_chat() && self.sidebar.view == sidebar::View::Buddies {
            self.input.set(&trimmed);
            return self.flash("Pick a Buddy on the left to talk to");
        }
        if !self.has_chat() {
            if trimmed.starts_with('!') {
                self.input.set(&trimmed);
                return self.flash("Open a session first — shell commands run in its task");
            }
            // A message from the start page: a new session with the default
            // agent, sent once it is ready.
            self.pending_prompt = Some(trimmed);
            let (project_id, task_id) =
                (self.target.project.id.clone(), self.target.task_id.clone());
            self.new_session(&project_id, &task_id, None).await;
            if !self.has_chat() {
                if let Some(text) = self.pending_prompt.take() {
                    self.input.set(&text);
                }
            }
            return;
        }
        if self.out.is_none() {
            self.pending_prompt = Some(trimmed);
            return self.flash("Not connected — your message goes out once reconnected");
        }
        if let Some(command) = trimmed.strip_prefix('!') {
            self.send(wire::shell(command.trim()));
            return;
        }
        self.send_prompt(&trimmed);
    }

    fn send_prompt(&mut self, text: &str) {
        if self.session.remote_owner.is_some() {
            self.notice(
                Level::Warn,
                "This session is owned by another Grove process; it is read-only here.",
            );
            return;
        }
        let queue = self.session.busy;
        let config = self.pending_config.take();
        self.send(wire::prompt(text, &wire::new_message_id(), queue, config));
        self.scroll_top = None;
    }

    /// Remember a setting to send with the next prompt.
    fn queue_config(&mut self, key: &str, value: &str) {
        let mut config = self.pending_config.take().unwrap_or_else(|| json!({}));
        config[key] = json!(value);
        self.pending_config = Some(config);
    }

    fn set_mode(&mut self, id: String) {
        // Agents that expose the mode as a config option refuse `set_mode`.
        match self.session.settings.mode_config.clone() {
            Some(config_id) => self.send(wire::set_config_option(&config_id, &id)),
            None => self.send(wire::set_mode(&id)),
        }
        self.session.settings.current_mode = Some(id);
    }

    fn set_model(&mut self, id: String) {
        if let Some(config_id) = self.session.settings.model_config.clone() {
            self.send(wire::set_config_option(&config_id, &id));
            self.session.settings.current_model = Some(id);
        } else {
            self.queue_config("model", &id);
            self.flash("The model applies from your next message");
        }
    }

    fn set_thought(&mut self, id: String) {
        if let Some(config_id) = self.session.settings.thought_config.clone() {
            self.send(wire::set_config_option(&config_id, &id));
            self.session.settings.current_thought = Some(id);
        } else {
            self.queue_config("thought_level", &id);
            self.flash("Thinking effort applies from your next message");
        }
    }

    // ── Sidebar ────────────────────────────────────────────────────────────

    /// Reload the sidebar in the background: the project, its sessions,
    /// live states and the Buddies.
    fn refresh_sidebar(&self) {
        let conn = self.conn.clone();
        let project_id = self.sidebar.project.id.clone();
        let events = self.events.clone();
        let current = self.sidebar.project.clone();
        tokio::spawn(async move {
            // No project yet (the Buddies, or straight from the projects
            // page): still load the Buddies.
            let project = if project_id.is_empty() {
                current
            } else {
                match api::project(&conn, &project_id).await {
                    Ok(project) => project,
                    Err(_) => return,
                }
            };
            let projects = api::projects(&conn).await.unwrap_or_default();
            let mut sessions = HashMap::new();
            for task in project
                .chat_tasks()
                .into_iter()
                .filter(|_| !project_id.is_empty())
            {
                // Every task's sessions: counts show even when collapsed.
                if let Ok(chats) = api::chats(&conn, &project.id, &task.id).await {
                    sessions.insert(task.id, chats);
                }
            }
            let data = SidebarData {
                active: api::active_chats(&conn).await,
                buddies: api::buddies(&conn).await.unwrap_or_default(),
                projects,
                project,
                sessions,
            };
            let _ = events.send(AppEvent::Sidebar(Box::new(data)));
        });
    }

    fn apply_sidebar(&mut self, data: SidebarData) {
        if data.project.id != self.sidebar.project.id {
            return;
        }
        let row = self.sidebar.rows().get(self.sidebar.cursor).cloned();
        self.sidebar.project = data.project;
        self.sidebar.projects = data.projects;
        self.sidebar.sessions = data.sessions;
        self.sidebar.active = data.active;
        self.sidebar.buddies = data.buddies;
        if let Some(row) = row {
            self.sidebar.select(&row);
        }
        self.sidebar.clamp();
        if !self.has_chat() {
            self.target.project = self.sidebar.project.clone();
        }
    }

    fn focus_sidebar(&mut self) {
        self.sidebar.visible = true;
        self.sidebar.focused = true;
    }

    fn focus_chat(&mut self) {
        self.sidebar.focused = false;
        self.sidebar.prompt = None;
    }

    async fn switch_project(&mut self, project_id: &str) {
        match api::project(&self.conn, project_id).await {
            Ok(project) => {
                self.sidebar.project = project;
                self.sidebar.expanded.clear();
                self.sidebar.sessions.clear();
                self.sidebar.view = sidebar::View::Project;
                self.sidebar.cursor = 0;
                if !self.has_chat() {
                    self.target.project = self.sidebar.project.clone();
                    self.target.task_id = api::LOCAL_TASK_ID.into();
                }
                self.refresh_sidebar();
            }
            Err(e) => self.flash(format!("Could not open the project: {e}")),
        }
    }

    async fn sidebar_key(&mut self, key: KeyEvent) {
        let action = self.sidebar.key(key);
        let project_id = self.sidebar.project.id.clone();
        let result = match action {
            SideAction::Stay => Ok(()),
            SideAction::Leave => {
                self.focus_chat();
                Ok(())
            }
            SideAction::Open {
                project_id,
                task_id,
                chat_id,
            } => {
                self.open_chat(&project_id, &task_id, &chat_id).await;
                self.focus_chat();
                Ok(())
            }
            SideAction::NewSession {
                project_id,
                task_id,
            } => {
                self.open_agent(0, Some((project_id, task_id))).await;
                Ok(())
            }
            SideAction::ShowProjects => {
                self.open_projects().await;
                Ok(())
            }
            SideAction::NewTask(name) => api::create_task(&self.conn, &project_id, &name)
                .await
                .map(|task| {
                    self.sidebar.expanded.insert(task.id.clone());
                    self.flash(format!("Created {}", task.name));
                }),
            SideAction::RenameTask(task_id, name) => {
                api::rename_task(&self.conn, &project_id, &task_id, &name).await
            }
            SideAction::RenameSession {
                task_id,
                chat_id,
                title,
            } => {
                let result =
                    api::rename_chat(&self.conn, &project_id, &task_id, &chat_id, &title).await;
                if result.is_ok() && chat_id == self.target.chat.id {
                    self.target.chat.title = title;
                }
                result
            }
            SideAction::ArchiveTask { task_id, force } => {
                match api::archive_task(&self.conn, &project_id, &task_id, force).await {
                    Err(super::conn::ConnError::Status { message, .. }) if !force => {
                        // Unmerged or uncommitted work: say why, ask again.
                        self.sidebar.prompt = Some(SidePrompt::ArchiveTask {
                            task_id,
                            reason: Some(message),
                        });
                        Ok(())
                    }
                    other => other,
                }
            }
            SideAction::ArchiveSession { task_id, chat_id } => {
                api::archive_chat(&self.conn, &project_id, &task_id, &chat_id).await
            }
            SideAction::Pin {
                task_id,
                chat_id,
                pinned,
            } => api::pin_chat(&self.conn, &project_id, &task_id, &chat_id, pinned).await,
            SideAction::Info => {
                self.info();
                Ok(())
            }
            SideAction::OpenBuddy {
                name,
                project_id,
                chat_id,
            } => {
                self.open_chat(&project_id, api::LOCAL_TASK_ID, &chat_id)
                    .await;
                if self.target.chat.id == chat_id {
                    self.buddy = Some(name);
                    self.sidebar.view = sidebar::View::Buddies;
                }
                self.focus_chat();
                Ok(())
            }
        };
        if let Err(e) = result {
            self.flash(format!("{e}"));
        }
        self.refresh_sidebar();
    }

    /// `/info`: where this conversation is, in a few lines.
    fn info(&mut self) {
        let p = self.palette.clone();
        let project = &self.target.project;
        let task = project
            .chat_tasks()
            .into_iter()
            .find(|task| task.id == self.target.task_id);
        let row = |key: &str, value: String| {
            Line::from(vec![
                Span::styled(format!("  {key:<10}"), p.style(p.muted)),
                Span::styled(value, p.style(p.text)),
            ])
        };
        let mut lines = vec![Line::from(Span::styled(
            "Info",
            p.style(p.text).add_modifier(Modifier::BOLD),
        ))];
        lines.push(row(
            "Project",
            format!(
                "{} · {} · {}",
                project.name,
                if project.project_type == "studio" {
                    "studio"
                } else {
                    "repo"
                },
                project.path
            ),
        ));
        if let Some(task) = task {
            let mut facts = vec![task.name.clone()];
            if !task.branch.is_empty() {
                facts.push(if task.target.is_empty() {
                    task.branch.clone()
                } else {
                    format!("{} → {}", task.branch, task.target)
                });
            }
            if !task.commits.is_empty() {
                facts.push(format!("{} commits ahead", task.commits.len()));
            }
            if task.additions + task.deletions > 0 {
                facts.push(format!("+{} −{}", task.additions, task.deletions));
            }
            if !task.status.is_empty() {
                facts.push(task.status.clone());
            }
            lines.push(row("Task", facts.join(" · ")));
            lines.push(row("Directory", task.path.clone()));
        }
        if self.has_chat() {
            let settings = &self.session.settings;
            let mut facts = vec![
                self.target.chat.title.clone(),
                self.agent_name(&self.target.chat.agent),
            ];
            facts.extend(settings.model_name());
            facts.extend(settings.mode_name());
            facts.extend(settings.thought_name());
            if let Some((used, size)) = self.session.context.filter(|(_, size)| *size > 0) {
                facts.push(format!("context {}%", used * 100 / size));
            }
            lines.push(row("Session", facts.join(" · ")));
            lines.push(row("Id", self.target.chat.id.clone()));
        }
        lines.push(Line::default());
        self.print(lines);
        self.scroll_top = None;
    }

    /// ⌃G: a shell in this task's directory, until it exits.
    fn shell(&mut self) {
        if self.conn.remote {
            return self.flash("The task lives on the server — use !command to run commands there");
        }
        let dir = self
            .target
            .project
            .chat_tasks()
            .into_iter()
            .find(|task| task.id == self.target.task_id)
            .map(|task| task.path)
            .filter(|path| !path.is_empty())
            .unwrap_or_else(|| self.target.project.path.clone());
        self.shell_request = Some(dir);
    }

    // ── Projects page ──────────────────────────────────────────────────────

    async fn open_projects(&mut self) {
        let projects = match api::projects(&self.conn).await {
            Ok(projects) => projects,
            Err(e) => return self.flash(format!("Could not list projects: {e}")),
        };
        let buddies = api::buddies(&self.conn).await.unwrap_or_default();
        let current = if self.sidebar.view == sidebar::View::Buddies {
            Some(screens::BUDDIES.to_string())
        } else {
            (!self.target.project.id.is_empty()).then(|| self.target.project.id.clone())
        };
        let selected = projects
            .iter()
            .position(|p| Some(&p.id) == current.as_ref())
            .unwrap_or(0);
        self.screen = Some(Screen::Projects(Box::new(ProjectsPage {
            projects,
            buddies,
            selected,
            layout: Default::default(),
            current,
        })));
    }

    async fn page_action(&mut self, action: PageAction) {
        match action {
            PageAction::Stay => {}
            PageAction::Close => self.screen = None,
            PageAction::Quit => self.quit = true,
            PageAction::OpenProject(id) => {
                self.screen = None;
                if id != self.sidebar.project.id || self.sidebar.view != sidebar::View::Project {
                    self.sidebar.view = sidebar::View::Project;
                    self.switch_project(&id).await;
                }
                self.focus_sidebar();
            }
            PageAction::Theme => self.open_theme(),
            PageAction::OpenBuddies => {
                if let Some(Screen::Projects(page)) = &self.screen {
                    self.sidebar.buddies = page.buddies.clone();
                }
                self.screen = None;
                self.sidebar.view = sidebar::View::Buddies;
                self.sidebar.cursor = 2;
                self.focus_sidebar();
                self.refresh_sidebar();
            }
            PageAction::AddProject => {
                let dir = std::env::current_dir().unwrap_or_default();
                match api::add_project(&self.conn, &dir.to_string_lossy()).await {
                    Ok(project) => {
                        self.screen = None;
                        self.sidebar.view = sidebar::View::Project;
                        self.switch_project(&project.id).await;
                        self.focus_sidebar();
                    }
                    Err(e) => self.flash(format!("Could not add this directory: {e}")),
                }
            }
        }
    }

    /// A left click: open what is under it.
    async fn click(&mut self, x: u16, y: u16) {
        if let Some(Screen::Projects(page)) = &self.screen {
            if let Some(index) = page.hit(x, y) {
                let action = page.activate(index);
                if let Some(Screen::Projects(page)) = self.screen.as_mut() {
                    page.selected = index;
                }
                self.page_action(action).await;
            }
            return;
        }
        if self.screen.is_some() {
            return;
        }
        if x < self.sidebar_area.width {
            self.sidebar.focused = true;
            if let Some(index) = self.sidebar.hit(self.sidebar_area, y) {
                self.sidebar.cursor = index;
                self.sidebar_key(KeyEvent::from(KeyCode::Enter)).await;
            }
        } else {
            self.focus_chat();
        }
    }

    // ── Theme ──────────────────────────────────────────────────────────────

    fn open_theme(&mut self) {
        let config = crate::storage::config::load_config();
        let current = if config.theme.mode == "auto" {
            Theme::Auto
        } else {
            Palette::configured()
        };
        let row = Theme::all().iter().position(|t| *t == current).unwrap_or(0);
        self.theme_picker = Some((row, self.palette.clone()));
    }

    /// ↑↓ previews, ⏎ keeps (and saves for the GUI too), esc restores.
    fn theme_key(&mut self, key: KeyEvent) {
        let Some((row, original)) = self.theme_picker.clone() else {
            return;
        };
        let themes = Theme::all();
        let row = match key.code {
            KeyCode::Up | KeyCode::Char('k') => (row + themes.len() - 1) % themes.len(),
            KeyCode::Down | KeyCode::Char('j') => (row + 1) % themes.len(),
            KeyCode::Enter => {
                crate::theme::save_theme(themes[row]);
                self.theme_picker = None;
                self.transcript.key = None;
                return self.flash(format!("Theme: {}", themes[row].label()));
            }
            KeyCode::Esc | KeyCode::Char('q') => {
                self.palette = original;
                self.theme_picker = None;
                self.transcript.key = None;
                return;
            }
            _ => return,
        };
        self.palette = Palette::for_theme(themes[row]);
        // Finished lines carry the old colors; render them again.
        self.transcript.key = None;
        self.theme_picker = Some((row, original));
    }

    /// The theme list, centred over everything.
    fn theme_lines(&self, row: usize) -> Vec<Line<'static>> {
        let p = &self.palette;
        let mut lines = vec![
            Line::from(Span::styled(
                "THEME",
                p.style(p.muted).add_modifier(Modifier::BOLD),
            )),
            Line::default(),
        ];
        for (index, theme) in Theme::all().iter().enumerate() {
            let colors = crate::theme::get_theme_colors(*theme);
            let selected = index == row;
            let swatch = |color| Span::styled("  ", Style::default().bg(color));
            let mut line = Line::from(vec![
                Span::styled(
                    if selected { "❯ " } else { "  " },
                    p.style(p.highlight).add_modifier(Modifier::BOLD),
                ),
                swatch(colors.bg),
                swatch(colors.highlight),
                swatch(colors.status_live),
                Span::raw("  "),
                Span::styled(
                    screens::pad(theme.label(), 20),
                    if selected {
                        p.style(p.highlight).add_modifier(Modifier::BOLD)
                    } else {
                        p.style(p.text)
                    },
                ),
            ]);
            if selected {
                line.style = Style::default().bg(p.panel);
            }
            lines.push(line);
        }
        lines.push(Line::default());
        lines.push(hints(
            p,
            &[("↑↓", "preview"), ("⏎", "keep"), ("esc", "cancel")],
        ));
        lines
    }

    // ── Agent panel ────────────────────────────────────────────────────────

    async fn open_agent(&mut self, tab: usize, new_in: Option<(String, String)>) {
        let agents = match api::agents(&self.conn).await {
            Ok(agents) => agents,
            Err(e) => return self.flash(format!("Could not list agents: {e}")),
        };
        self.agent_names = agents
            .iter()
            .map(|a| (a.id.clone(), a.name.clone()))
            .collect();
        let new_in = new_in.or_else(|| (!self.has_chat()).then(|| self.here()));
        let place = match &new_in {
            Some((project_id, task_id)) if *project_id != self.target.project.id => {
                match api::project(&self.conn, project_id).await {
                    Ok(project) => format!("{} › {}", project.name, project.task_name(task_id)),
                    Err(_) => task_id.clone(),
                }
            }
            Some((_, task_id)) => format!(
                "{} › {}",
                self.target.project.name,
                self.target.project.task_name(task_id)
            ),
            None => String::new(),
        };
        let panel = AgentPanel {
            tab: if new_in.is_some() { 0 } else { tab },
            new_in,
            place,
            agents,
            cursor: [0; 4],
            settings: self.session.settings.clone(),
            current_agent: self.target.chat.agent.clone(),
            context: self.session.context,
            here: (self.target.project.id.clone(), self.target.task_id.clone()),
        }
        .with_cursors();
        self.screen = Some(Screen::Agent(Box::new(panel)));
    }

    async fn screen_key(&mut self, key: KeyEvent) {
        if let Some(Screen::Projects(page)) = self.screen.as_mut() {
            let action = page.key(key);
            return self.page_action(action).await;
        }
        let action = match self.screen.as_mut() {
            Some(Screen::Agent(panel)) => panel.key(key),
            _ => return,
        };
        match action {
            Action::Stay => {}
            Action::Close => self.screen = None,
            Action::New {
                project_id,
                task_id,
                agent,
            } => {
                self.new_session(&project_id, &task_id, agent.as_deref())
                    .await;
                self.focus_chat();
                self.refresh_sidebar();
            }
            Action::Mode(id) => {
                self.set_mode(id);
                self.screen = None;
            }
            Action::Model(id) => {
                self.set_model(id);
                self.screen = None;
            }
            Action::Thought(id) => {
                self.set_thought(id);
                self.screen = None;
            }
        }
    }

    // ── Agent questions ────────────────────────────────────────────────────

    /// Point the draft at the first open form, starting a new one when a
    /// different form comes first, and dropping it when none is left.
    fn sync_draft(&mut self) {
        let Some(form) = self.session.forms.first().cloned() else {
            self.finish_form();
            return;
        };
        if let Some(draft) = self.draft.as_mut().filter(|d| d.id == form.id) {
            if form.error.is_some() {
                draft.sent = false;
            }
            return;
        }
        let stash = match self.draft.take() {
            Some(draft) => draft.stash,
            None => self.input.text(),
        };
        let mut draft = Draft::new(&form, stash);
        self.input.clear();
        if let Some(text) = draft.load(&form) {
            self.input.set(&text);
        }
        self.draft = Some(draft);
    }

    /// Leave the form and give the input box back what was typed before it.
    fn finish_form(&mut self) {
        if let Some(draft) = self.draft.take() {
            self.input.clear();
            self.input.set(&draft.stash);
        }
    }

    /// Dismiss an `ask_form`, or decline / cancel an elicitation.
    fn close_form(&mut self, form: &Form, action: &str) {
        if form.is_elicitation() {
            self.send(wire::elicitation(&form.id, action, None));
        } else {
            self.send(wire::ask_form_resolved(&form.id));
        }
        self.session.forms.retain(|f| f.id != form.id);
        self.finish_form();
        self.sync_draft();
    }

    /// Store the current answer and move on; past the last question, send.
    fn confirm_answer(&mut self, form: &Form) {
        let typed_text = self.input.text();
        let Some(draft) = self.draft.as_mut() else {
            return;
        };
        if let Some(open) = self.session.forms.first_mut() {
            open.error = None;
        }
        match draft.answer(form, &typed_text) {
            Ok(answer) => draft.answers[draft.step] = answer,
            Err(error) => {
                draft.error = Some(error);
                return;
            }
        }
        self.next_question(form);
    }

    fn next_question(&mut self, form: &Form) {
        let Some(draft) = self.draft.as_mut() else {
            return;
        };
        if draft.step + 1 < form.questions.len() {
            draft.step += 1;
            self.input.clear();
            if let Some(text) = draft.load(form) {
                self.input.set(&text);
            }
            return;
        }
        let answers = draft.answers.clone();
        if form.is_elicitation() {
            draft.sent = true;
            draft.error = None;
            self.send(wire::elicitation(
                &form.id,
                "accept",
                Some(form.answers_content(&answers)),
            ));
            return;
        }
        // An `ask_form` is answered by a normal prompt the agent reads next.
        self.send(wire::ask_form_resolved(&form.id));
        self.session.forms.retain(|f| f.id != form.id);
        self.finish_form();
        self.send_prompt(&form.answers_markdown(&answers));
        self.sync_draft();
    }

    /// Keys for the open form. Returns whether the key was used; anything
    /// else (typing, slash commands, ctrl shortcuts) works as usual.
    fn form_key(&mut self, key: KeyEvent) -> bool {
        let Some(form) = self.session.forms.first().cloned() else {
            return false;
        };
        if self.draft.is_none() || self.input.text().starts_with('/') {
            return false;
        }
        let ctrl = key.modifiers.contains(KeyModifiers::CONTROL);
        match key.code {
            KeyCode::Esc => {
                self.close_form(&form, "cancel");
                return true;
            }
            KeyCode::Char('x') if ctrl && form.is_elicitation() => {
                self.close_form(&form, "decline");
                return true;
            }
            _ => {}
        }
        if let Source::Url { url, opened } = &form.source {
            if key.code != KeyCode::Enter {
                return false;
            }
            if !opened {
                if open::that(url).is_err() {
                    self.flash(format!("Open {url} in your browser"));
                }
                self.send(wire::elicitation(&form.id, "accept", None));
            }
            return true;
        }
        let sent = self.draft.as_ref().is_some_and(|d| d.sent);
        if form.unsupported || sent {
            return key.code == KeyCode::Enter;
        }
        let step = self.draft.as_ref().map(|d| d.step).unwrap_or(0);
        let Some(question) = form.questions.get(step) else {
            return false;
        };
        let rows = ask::rows(question);
        let empty = self.input.is_empty();
        let typed_text = self.input.text();
        let Some(draft) = self.draft.as_mut() else {
            return false;
        };
        match key.code {
            KeyCode::BackTab => {
                if draft.step > 0 {
                    if let Ok(answer) = draft.answer(&form, &typed_text) {
                        draft.answers[draft.step] = answer;
                    }
                    draft.step -= 1;
                    self.input.clear();
                    if let Some(text) = draft.load(&form) {
                        self.input.set(&text);
                    }
                }
            }
            KeyCode::Tab => {
                if question.required {
                    draft.error = Some(format!("{} is required", question.title));
                } else {
                    draft.answers[draft.step] = None;
                    self.next_question(&form);
                }
            }
            KeyCode::Enter if !key.modifiers.contains(KeyModifiers::ALT) => {
                self.confirm_answer(&form)
            }
            KeyCode::Up if rows > 0 && empty => draft.cursor = draft.cursor.saturating_sub(1),
            KeyCode::Down if rows > 0 && empty => draft.cursor = (draft.cursor + 1).min(rows - 1),
            KeyCode::Char(' ') if question.kind == Kind::Multi && empty => {
                if let Some(picked) = draft.picked.get_mut(draft.cursor) {
                    *picked = !*picked;
                }
            }
            KeyCode::Char(ch @ '1'..='9') if rows > 0 && empty && !ctrl => {
                let index = ch as usize - '1' as usize;
                if index < rows {
                    draft.cursor = index;
                    if question.kind == Kind::Multi {
                        draft.picked[index] = !draft.picked[index];
                    } else {
                        self.confirm_answer(&form);
                    }
                }
            }
            KeyCode::Char(ch @ ('y' | 'n')) if question.kind == Kind::Boolean && empty && !ctrl => {
                draft.cursor = usize::from(ch == 'n');
                self.confirm_answer(&form);
            }
            _ => return false,
        }
        true
    }

    // ── Permission ─────────────────────────────────────────────────────────

    /// Keys for an open permission request (only with an empty input box,
    /// so the user can still type a reply instead). Returns whether used.
    fn permission_key(&mut self, key: KeyEvent) -> bool {
        let Some(permission) = self.session.permission.clone() else {
            return false;
        };
        if !self.input.is_empty() {
            return false;
        }
        if self.permission_row.0 != permission.id {
            self.permission_row = (permission.id.clone(), 0);
        }
        let count = permission.options.len();
        let answer = |app: &mut Self, index: usize| {
            if let Some(option) = permission.options.get(index) {
                app.send(wire::permission(&permission.id, &option.id));
                app.session.permission = None;
            }
        };
        match key.code {
            KeyCode::Up => self.permission_row.1 = self.permission_row.1.saturating_sub(1),
            KeyCode::Down => {
                self.permission_row.1 = (self.permission_row.1 + 1).min(count.saturating_sub(1))
            }
            KeyCode::Enter => answer(self, self.permission_row.1),
            KeyCode::Char(ch @ '1'..='9') => answer(self, ch as usize - '1' as usize),
            KeyCode::Esc => {
                let reject = permission
                    .options
                    .iter()
                    .position(|o| o.kind.starts_with("reject"))
                    .unwrap_or(count.saturating_sub(1));
                answer(self, reject);
            }
            _ => return false,
        }
        true
    }

    // ── Commands ───────────────────────────────────────────────────────────

    async fn run_command(&mut self, line: &str) {
        let command = line.split_whitespace().next().unwrap_or("");
        match command {
            "/new" => self.open_agent(0, Some(self.here())).await,
            "/sessions" => self.focus_sidebar(),
            "/projects" => self.open_projects().await,
            "/info" => self.info(),
            "/theme" => self.open_theme(),
            "/shell" => self.shell(),
            "/agent" => self.open_agent(0, None).await,
            "/model" => self.open_agent(1, None).await,
            "/mode" => self.open_agent(2, None).await,
            "/effort" => self.open_agent(3, None).await,
            "/plan" => match self.session.plan_doc.clone() {
                Some((title, text)) => {
                    self.transcript
                        .push(Item::Block(Block::Document { title, text }), &self.palette);
                    self.scroll_top = None;
                }
                None => self.flash("The agent has not written a plan in this session"),
            },
            "/queue" => {
                if self.session.queue.is_empty() {
                    self.flash("Nothing queued");
                } else {
                    self.queue_picker = Some(QueuePicker { selected: 0 });
                }
            }
            "/cancel" => self.cancel(),
            "/verbose" => self.toggle_verbose(),
            "/retry-auth" => self.send(wire::retry_authentication()),
            "/help" => self.help(),
            "/quit" | "/exit" => self.quit = true,
            other => {
                let name = other.trim_start_matches('/');
                if self.has_chat() && self.session.agent_commands.iter().any(|c| c.name == name) {
                    // The agent's own command travels as a prompt.
                    self.send_prompt(line.trim());
                } else {
                    self.flash(format!("Unknown command {other} — type / to see them"));
                }
            }
        }
    }

    fn cancel(&mut self) {
        if self.session.busy {
            self.send(wire::cancel());
            self.flash("Interrupting…");
        }
    }

    fn toggle_verbose(&mut self) {
        self.verbose = !self.verbose;
        self.flash(if self.verbose {
            "Showing full tool output and thinking"
        } else {
            "Showing summaries"
        });
    }

    fn help(&mut self) {
        let p = self.palette.clone();
        let rows = [
            ("⏎", "send · queues while the agent works"),
            ("⌥⏎ / ⌃J", "new line"),
            ("esc", "interrupt the agent · close a menu"),
            ("↑↓ ⏎ / 1–9", "answer a permission request or a question"),
            (
                "PgUp PgDn / wheel",
                "scroll the conversation · End follows it again",
            ),
            ("!command", "run a shell command in the task"),
            ("⌃T  ⌃R  ⌃N", "target · sessions · new session"),
            ("⌃O", "full tool output and thinking"),
            (
                "⌃C twice / ⌃D",
                "leave — the session keeps running on the server",
            ),
            ("shift-drag", "select text to copy"),
        ];
        let mut lines = vec![Line::from(Span::styled(
            "Keys",
            p.style(p.text).add_modifier(Modifier::BOLD),
        ))];
        for (key, what) in rows {
            lines.push(Line::from(vec![
                Span::styled(format!("  {key:<22}"), p.style(p.info)),
                Span::styled(what, p.style(p.muted)),
            ]));
        }
        lines.push(Line::default());
        self.print(lines);
        self.scroll_top = None;
    }

    fn menu_matches(&self) -> Vec<MenuItem> {
        let text = self.input.text();
        if !text.starts_with('/') || text.contains(' ') || text.contains('\n') {
            return Vec::new();
        }
        let grove = COMMANDS.iter().map(|(name, about, keys, group)| MenuItem {
            name: name.to_string(),
            about: about.to_string(),
            keys: keys.to_string(),
            group,
            agent: false,
        });
        // The agent's own commands, unless Grove already uses the name.
        let agent = self
            .session
            .agent_commands
            .iter()
            .filter(|command| !COMMANDS.iter().any(|(name, ..)| name[1..] == command.name))
            .map(|command| MenuItem {
                name: format!("/{}", command.name),
                about: command.description.clone(),
                keys: command.hint.clone().unwrap_or_default(),
                group: "From the agent",
                agent: true,
            });
        // Without a session only the commands that find or start one apply.
        let home = !self.has_chat();
        grove
            .chain(agent)
            .filter(|item| {
                !home
                    || ["/new", "/sessions", "/projects", "/info", "/quit"]
                        .contains(&item.name.as_str())
            })
            .filter(|item| item.name.starts_with(text.as_str()))
            .collect()
    }

    // ── Keys ───────────────────────────────────────────────────────────────

    fn scroll(&mut self, delta: i32) {
        let max_top = self.view_lines.saturating_sub(self.view_height);
        let top = self.scroll_top.unwrap_or(max_top) as i64 + i64::from(delta);
        let top = top.clamp(0, max_top as i64) as usize;
        self.scroll_top = (top < max_top).then_some(top);
    }

    async fn on_key(&mut self, key: KeyEvent) {
        if key.kind == KeyEventKind::Release {
            return;
        }
        let ctrl = key.modifiers.contains(KeyModifiers::CONTROL);
        let alt = key.modifiers.contains(KeyModifiers::ALT);

        if !matches!(key.code, KeyCode::Char('c')) || !ctrl {
            self.quit_armed = None;
        }
        if self.theme_picker.is_some() {
            return self.theme_key(key);
        }
        if ctrl && key.code == KeyCode::Char('c') {
            // On every page: clear, interrupt, then leave on a second press.
            if !self.input.is_empty() {
                self.input.clear();
            } else if self.screen.is_none() && self.session.busy {
                self.cancel();
            } else if self
                .quit_armed
                .is_some_and(|at| at.elapsed() < Duration::from_secs(2))
            {
                self.quit = true;
            } else {
                self.quit_armed = Some(Instant::now());
                self.flash("Press ⌃C again to leave");
            }
            return;
        }

        if self.screen.is_some() {
            if key.code == KeyCode::Char('d') && ctrl && self.input.is_empty() {
                self.quit = true;
                return;
            }
            return self.screen_key(key).await;
        }

        // ⌃B: sidebar in and out of focus (and view).
        if ctrl && key.code == KeyCode::Char('b') {
            if self.sidebar.focused && self.sidebar.visible {
                if self.has_chat() {
                    self.sidebar.visible = false;
                }
                self.focus_chat();
            } else {
                self.focus_sidebar();
                self.refresh_sidebar();
            }
            return;
        }
        if ctrl && key.code == KeyCode::Char('g') {
            return self.shell();
        }
        if self.sidebar.focused && self.sidebar.visible {
            if ctrl && key.code == KeyCode::Char('d') {
                self.quit = true;
                return;
            }
            return self.sidebar_key(key).await;
        }

        let half = (self.view_height / 2).max(1) as i32;
        match key.code {
            KeyCode::PageUp => return self.scroll(-half),
            KeyCode::PageDown => return self.scroll(half),
            KeyCode::End if self.input.is_empty() => {
                self.scroll_top = None;
                return;
            }
            _ => {}
        }

        if let Some(picker) = self.queue_picker.as_mut() {
            let count = self.session.queue.len();
            match key.code {
                KeyCode::Esc => self.queue_picker = None,
                KeyCode::Up => picker.selected = picker.selected.saturating_sub(1),
                KeyCode::Down => {
                    picker.selected = (picker.selected + 1).min(count.saturating_sub(1))
                }
                KeyCode::Enter => {
                    if let Some(queued) = self.session.queue.get(picker.selected) {
                        let id = queued.id.clone();
                        self.send(wire::dequeue(&id));
                    }
                    self.queue_picker = None;
                }
                _ => {}
            }
            return;
        }

        if self.permission_key(key) {
            return;
        }
        if self.session.permission.is_none() && self.form_key(key) {
            return;
        }

        let menu = self.menu_matches();
        match key.code {
            KeyCode::Enter if alt => self.input.insert('\n'),
            KeyCode::Char('j') if ctrl => self.input.insert('\n'),
            KeyCode::Enter => {
                if !menu.is_empty() {
                    let item = &menu[self.menu_selected.min(menu.len() - 1)];
                    self.menu_selected = 0;
                    if item.agent && !item.keys.is_empty() {
                        // It takes an argument: let the user type it.
                        self.input.set(&format!("{} ", item.name));
                    } else {
                        let name = item.name.clone();
                        self.input.clear();
                        self.run_command(&name).await;
                    }
                } else if self.input.text().trim_start().starts_with('/') {
                    let line = self.input.take();
                    self.run_command(line.trim()).await;
                } else {
                    self.submit().await;
                }
            }
            KeyCode::Tab => {
                if let Some(item) = menu.get(self.menu_selected.min(menu.len().saturating_sub(1))) {
                    self.input.set(&item.name);
                }
            }
            KeyCode::Esc => {
                if !menu.is_empty() {
                    self.input.clear();
                } else if self.scroll_top.is_some() {
                    self.scroll_top = None;
                } else if self.session.busy {
                    self.cancel();
                } else {
                    // Nothing to stop: back to the sidebar.
                    self.focus_sidebar();
                }
            }
            KeyCode::Up if !menu.is_empty() => {
                self.menu_selected = self.menu_selected.saturating_sub(1)
            }
            KeyCode::Down if !menu.is_empty() => {
                self.menu_selected = (self.menu_selected + 1).min(menu.len() - 1);
            }
            KeyCode::Up if !self.input.is_multiline() => self.input.history_prev(),
            KeyCode::Down if !self.input.is_multiline() => self.input.history_next(),
            KeyCode::Char('d') if ctrl => {
                if self.input.is_empty() {
                    self.quit = true;
                } else {
                    self.input.delete();
                }
            }
            KeyCode::Char('n') if ctrl => self.open_agent(0, Some(self.here())).await,
            KeyCode::Char('q') if ctrl => self.run_command("/queue").await,
            KeyCode::Char('o') if ctrl => self.toggle_verbose(),
            KeyCode::Char('a') if ctrl => self.input.home(),
            KeyCode::Char('e') if ctrl => self.input.end(),
            KeyCode::Char('u') if ctrl => self.input.kill_to_start(),
            KeyCode::Char('w') if ctrl => self.input.kill_word(),
            KeyCode::Char(ch) if !ctrl => {
                self.input.insert(ch);
                self.menu_selected = 0;
            }
            KeyCode::Backspace => {
                self.input.backspace();
                self.menu_selected = 0;
            }
            KeyCode::Delete => self.input.delete(),
            KeyCode::Left => self.input.left(),
            KeyCode::Right => self.input.right(),
            KeyCode::Home => self.input.home(),
            KeyCode::End => self.input.end(),
            _ => {}
        }
    }

    fn on_server(&mut self, value: Value) {
        let kind = super::model::kind(&value).to_string();
        // Confirm an accepted elicitation in the transcript before the
        // session forgets the form.
        if kind == "elicitation_resolved"
            && value.get("action").and_then(Value::as_str) == Some("accept")
        {
            let id = value.get("request_id").and_then(Value::as_str);
            if let Some(draft) = self
                .draft
                .as_ref()
                .filter(|d| d.sent && Some(d.id.as_str()) == id)
            {
                if let Some(form) = self.session.forms.iter().find(|f| f.id == draft.id) {
                    let width = self.transcript.key.map(|k| k.0).unwrap_or(80);
                    let lines = ask::summary(form, &draft.answers, width, &self.palette);
                    self.print(lines);
                }
            }
        }
        self.session.apply(&value);
        self.sync_draft();
        if matches!(kind.as_str(), "session_ready" | "busy") {
            // The agent can take input now.
            if let Some(text) = self.pending_prompt.take() {
                self.send_prompt(&text);
            }
        }
        match kind.as_str() {
            "queue_message_gone" => self.flash("That message was already sent"),
            "remote_session" => self.notice(
                Level::Warn,
                "Another Grove process owns this session — showing it read-only.",
            ),
            "auth_required" => {
                let agent = self.session.auth_required.clone().unwrap_or_default();
                self.notice(
                    Level::Warn,
                    format!("{agent} needs you to sign in. Finish sign-in in the agent's own CLI or the Grove web UI, then run /retry-auth."),
                );
            }
            "session_ended" => self.notice(
                Level::Info,
                "The agent process ended. Send a message to start it again.",
            ),
            _ => {}
        }
        self.flush();
    }

    // ── Drawing ────────────────────────────────────────────────────────────

    /// What is still changing at the end of the conversation.
    fn live_lines(&self, width: usize) -> Vec<Line<'static>> {
        let p = &self.palette;
        let mut lines = Vec::new();
        for block in &self.session.blocks[self.flushed..] {
            lines.extend(render::block(block, width, p, self.frame, self.verbose));
        }
        if !self.session.plan.is_empty() {
            lines.extend(render::plan(&self.session.plan, width, p));
            lines.push(Line::default());
        }
        for sub in self.session.subagents.iter().filter(|sub| sub.working()) {
            let title = if sub.title.is_empty() {
                "Sub-agent"
            } else {
                &sub.title
            };
            let mut spans = vec![
                Span::styled(format!("↳ {} ", spinner(self.frame)), p.style(p.info)),
                Span::styled(title.to_string(), p.style(p.text)),
                Span::styled(format!(" · {}", sub.status()), p.style(p.muted)),
            ];
            if !sub.preview.is_empty() {
                spans.push(Span::styled(
                    format!(" · {}", screens::fit(&sub.preview, width / 2)),
                    p.style(p.faint),
                ));
            }
            lines.push(Line::from(spans));
        }
        if let Some(text) = &self.pending_prompt {
            for line in render::block(
                &Block::User {
                    text: text.clone(),
                    sender: None,
                },
                width,
                p,
                0,
                false,
            ) {
                lines.push(line);
            }
        }
        lines
    }

    /// The card floating above the input, if any: (lines, border color).
    fn floating(&self, width: usize) -> Option<(Vec<Line<'static>>, ratatui::style::Color)> {
        let p = &self.palette;
        let inner = width.saturating_sub(4);
        if let Some(picker) = &self.queue_picker {
            let mut lines = vec![Line::from(Span::styled(
                "QUEUED MESSAGES",
                p.style(p.muted).add_modifier(Modifier::BOLD),
            ))];
            for (index, queued) in self.session.queue.iter().enumerate() {
                let selected = index == picker.selected;
                let mut line = Line::from(vec![
                    Span::styled(if selected { "❯ " } else { "  " }, p.style(p.info)),
                    Span::styled(
                        screens::fit(queued.text.lines().next().unwrap_or(""), inner - 4),
                        p.style(p.text),
                    ),
                ]);
                if selected {
                    line.style = Style::default().bg(p.panel);
                }
                lines.push(line);
            }
            lines.push(hints(
                p,
                &[("↑↓", "select"), ("⏎", "remove"), ("esc", "close")],
            ));
            return Some((lines, p.border));
        }
        let menu = self.menu_matches();
        if !menu.is_empty() {
            return Some((self.menu_lines(&menu, inner), p.border));
        }
        if let Some(permission) = &self.session.permission {
            return Some((self.permission_lines(permission, inner), p.warn));
        }
        if let (Some(form), Some(draft)) = (self.session.forms.first(), &self.draft) {
            let mut lines = ask::lines(form, draft, inner, p);
            if self.session.forms.len() > 1 {
                lines.push(Line::from(Span::styled(
                    format!("  {} more questions waiting", self.session.forms.len() - 1),
                    p.style(p.faint),
                )));
            }
            return Some((lines, p.agent));
        }
        None
    }

    fn menu_lines(&self, menu: &[MenuItem], width: usize) -> Vec<Line<'static>> {
        let p = &self.palette;
        let selected = self.menu_selected.min(menu.len() - 1);
        let start = selected.saturating_sub(MENU_ROWS - 1);
        let mut lines = Vec::new();
        let mut group = "";
        for (index, item) in menu.iter().enumerate().skip(start).take(MENU_ROWS) {
            if item.group != group {
                group = item.group;
                lines.push(Line::from(Span::styled(
                    group.to_uppercase(),
                    p.style(p.muted).add_modifier(Modifier::BOLD),
                )));
            }
            let is_selected = index == selected;
            let about_w = width.saturating_sub(16 + 12).min(48);
            let mut line = Line::from(vec![
                Span::styled(
                    screens::pad(&item.name, 14),
                    if is_selected {
                        p.style(p.info).add_modifier(Modifier::BOLD)
                    } else {
                        p.style(p.text)
                    },
                ),
                Span::styled(screens::pad(&item.about, about_w), p.style(p.muted)),
                Span::styled(item.keys.clone(), p.style(p.faint)),
            ]);
            if is_selected {
                line.style = Style::default().bg(p.panel);
            }
            lines.push(line);
        }
        let more = menu.len().saturating_sub(start + MENU_ROWS);
        let mut footer = vec![
            ("↑↓", "select"),
            ("tab", "complete"),
            ("⏎", "run"),
            ("esc", "close"),
        ];
        let more_text = format!("{more} more");
        if more > 0 {
            footer.push(("…", more_text.as_str()));
        }
        lines.push(hints(p, &footer));
        lines
    }

    fn permission_lines(
        &self,
        permission: &super::model::Permission,
        width: usize,
    ) -> Vec<Line<'static>> {
        let p = &self.palette;
        let mut lines = vec![Line::from(vec![
            Span::styled("◆ ", p.style(p.warn)),
            Span::styled(
                permission.title.clone(),
                p.style(p.text).add_modifier(Modifier::BOLD),
            ),
            Span::styled("  needs your approval", p.style(p.muted)),
        ])];
        // Servers often repeat the title as the description.
        let description = if permission.description == permission.title {
            ""
        } else {
            permission.description.as_str()
        };
        for row in description.lines().take(4) {
            lines.extend(render::wrap(
                vec![Span::styled(row.to_string(), p.style(p.text))],
                width,
                &[],
            ));
        }
        if let Some(detail) = &permission.detail {
            for row in detail.lines().take(4) {
                lines.extend(render::wrap(
                    vec![Span::styled(row.to_string(), p.style(p.muted))],
                    width,
                    &[],
                ));
            }
        }
        lines.push(Line::default());
        let selected = if self.permission_row.0 == permission.id {
            self.permission_row.1
        } else {
            0
        };
        for (index, option) in permission.options.iter().enumerate() {
            let is_selected = index == selected;
            let mut line = Line::from(vec![
                Span::styled(
                    if is_selected {
                        format!("❯ {}  ", index + 1)
                    } else {
                        format!("  {}  ", index + 1)
                    },
                    if is_selected {
                        p.style(p.warn).add_modifier(Modifier::BOLD)
                    } else {
                        p.style(p.muted)
                    },
                ),
                Span::styled(
                    option.name.clone(),
                    if is_selected {
                        p.style(p.text).add_modifier(Modifier::BOLD)
                    } else {
                        p.style(p.text)
                    },
                ),
            ]);
            if is_selected {
                line.style = Style::default().bg(p.panel);
            }
            lines.push(line);
        }
        lines.push(Line::default());
        lines.push(hints(
            p,
            &[
                ("↑↓ / 1–9", "choose"),
                ("⏎", "confirm"),
                ("esc", "deny"),
                ("", "· also answerable on Web and phone"),
            ],
        ));
        lines
    }

    /// The line above the input: what the agent is doing.
    fn work_line(&self, width: usize) -> Line<'static> {
        let p = &self.palette;
        let mut left: Vec<Span<'static>> = Vec::new();
        if let Some(attempt) = self.reconnecting {
            left.push(Span::styled(
                format!("{} ", spinner(self.frame)),
                p.style(p.warn),
            ));
            left.push(Span::styled(
                format!("Reconnecting to the Grove server… attempt {}", attempt + 1),
                p.style(p.muted),
            ));
        } else if self.session.busy {
            let elapsed = self
                .session
                .busy_since
                .map(|since| render::format_elapsed(since.elapsed().as_secs()))
                .unwrap_or_default();
            left.push(Span::styled(
                format!("{} ", spinner(self.frame)),
                p.style(p.info),
            ));
            left.push(Span::styled(
                format!("Working · {elapsed}"),
                p.style(p.muted),
            ));
            if self.session.turn_tokens > 0 {
                left.push(Span::styled(
                    format!(
                        " · ↓ {} tokens",
                        render::compact_number(self.session.turn_tokens)
                    ),
                    p.style(p.muted),
                ));
            }
            left.push(Span::styled(" · ", p.style(p.muted)));
            left.push(Span::styled("esc", p.style(p.warn)));
            left.push(Span::styled(" interrupt", p.style(p.muted)));
        } else if self.session.compacting {
            left.push(Span::styled(
                format!("{} ", spinner(self.frame)),
                p.style(p.info),
            ));
            left.push(Span::styled("Compacting context…", p.style(p.muted)));
        } else if let Some(phase) = &self.session.phase {
            left.push(Span::styled(
                format!("{} ", spinner(self.frame)),
                p.style(p.info),
            ));
            left.push(Span::styled(
                format!(
                    "Starting {} · {phase}",
                    self.agent_name(&self.target.chat.agent)
                ),
                p.style(p.muted),
            ));
        } else if self.has_chat() && !self.session.ready && self.session.remote_owner.is_none() {
            left.push(Span::styled(
                format!("{} ", spinner(self.frame)),
                p.style(p.info),
            ));
            left.push(Span::styled(
                format!(
                    "Connecting to {}…",
                    self.agent_name(&self.target.chat.agent)
                ),
                p.style(p.muted),
            ));
        }
        let mut right: Vec<Span<'static>> = Vec::new();
        if self.scroll_top.is_some() {
            right.push(Span::styled("scrolled up · ", p.style(p.muted)));
            right.push(Span::styled("End", p.style(p.info)));
            right.push(Span::styled(" to follow", p.style(p.muted)));
        } else if !self.session.queue.is_empty() {
            right.push(Span::styled(
                format!("{} queued · ", self.session.queue.len()),
                p.style(p.warn),
            ));
            right.push(Span::styled("⌃Q", p.style(p.info)));
            right.push(Span::styled(" view", p.style(p.muted)));
        }
        spread(left, right, width)
    }

    fn status_line(&self, width: usize) -> Line<'static> {
        let p = &self.palette;
        let mut place = format!(
            "{}{} › {}",
            if self.conn.remote {
                format!("⇄ {} › ", self.conn.label())
            } else {
                String::new()
            },
            self.target.project.name,
            self.target.task_name(),
        );
        if self.has_chat() {
            place.push_str(&format!(" › {}", self.target.chat.title));
        }
        if let Some(buddy) = &self.buddy {
            place = format!("◈ {buddy} › {}", self.target.chat.title);
        }
        if !self.has_chat() && self.sidebar.view == sidebar::View::Buddies {
            place = "◈ Buddies".into();
        }
        let left = match &self.flash {
            Some((text, at)) if at.elapsed() < Duration::from_secs(4) => {
                vec![Span::styled(format!("◆ {text}"), p.style(p.warn))]
            }
            _ => vec![
                Span::styled(
                    "◆ ",
                    if self.reconnecting.is_some() {
                        p.style(p.warn)
                    } else {
                        p.style(p.accent)
                    },
                ),
                Span::styled(place, p.style(p.muted)),
            ],
        };
        let settings = &self.session.settings;
        let mut right = if self.reconnecting.is_some() {
            vec![Span::styled("reconnecting…", p.style(p.warn))]
        } else if !self.has_chat() {
            vec![
                Span::styled("⌃B", p.style(p.highlight)),
                Span::styled(" sidebar · ", p.style(p.muted)),
                Span::styled("⌃N", p.style(p.highlight)),
                Span::styled(" new session", p.style(p.muted)),
            ]
        } else {
            vec![Span::styled(
                match &self.buddy {
                    Some(buddy) => buddy.clone(),
                    None => self.agent_name(&self.target.chat.agent),
                },
                p.style(p.agent),
            )]
        };
        if self.has_chat() && self.reconnecting.is_none() {
            if let Some(model) = settings.model_name() {
                right.push(Span::styled(format!(" · {model}"), p.style(p.muted)));
            }
            if let Some(effort) = settings.thought_name() {
                right.push(Span::styled(format!(" · {effort}"), p.style(p.muted)));
            }
            if let Some(mode) = settings.mode_name() {
                right.push(Span::styled(format!(" · {mode}"), p.style(p.warn)));
            }
            if let Some((used, size)) = self.session.context.filter(|(_, size)| *size > 0) {
                right.push(Span::styled(
                    format!(" · ctx {}%", used * 100 / size),
                    p.style(p.muted),
                ));
            }
        }
        spread(left, right, width)
    }

    /// What the conversation area shows before a session is open.
    fn welcome_lines(&self, height: usize) -> Vec<Line<'static>> {
        let p = &self.palette;
        let server = if self.conn.remote {
            format!("connected to {}", self.conn.label())
        } else {
            format!(
                "local server {}",
                self.conn.base_url.trim_start_matches("http://")
            )
        };
        let mut body: Vec<Line<'static>> = screens::LOGO
            .iter()
            .map(|row| Line::from(Span::styled(row.to_string(), p.style(p.logo))))
            .collect();
        body.push(Line::default());
        body.push(Line::from(Span::styled(
            format!("v{} · {server}", env!("CARGO_PKG_VERSION")),
            p.style(p.muted),
        )));
        body.push(Line::default());
        if self.sidebar.view == sidebar::View::Buddies {
            body.push(Line::from(Span::styled(
                "Pick a Buddy on the left to talk to",
                p.style(p.muted),
            )));
        } else {
            body.push(Line::from(vec![
                Span::styled(
                    "Pick a session on the left, or type below to start one in ",
                    p.style(p.muted),
                ),
                Span::styled(
                    format!("{} › {}", self.target.project.name, self.target.task_name()),
                    p.style(p.text),
                ),
            ]));
        }
        body.push(Line::default());
        body.push(hints(
            p,
            &[
                ("⌃B", "sidebar"),
                ("⌃N", "new session"),
                ("/", "commands"),
                ("⌃D", "quit"),
            ],
        ));
        let pad = height.saturating_sub(body.len()) / 2;
        let mut lines = vec![Line::default(); pad];
        lines.extend(body);
        lines
    }

    fn input_hint(&self) -> String {
        let question = self.draft.as_ref().and_then(|draft| {
            let form = self.session.forms.first()?;
            Some((form, form.questions.get(draft.step)))
        });
        if self.session.permission.is_some() {
            "Answer above, or type to reply instead…".into()
        } else if let Some((form, question)) = question {
            match question {
                Some(q) if ask::typed(q) => "Type your answer…".into(),
                Some(_) if !form.is_elicitation() => {
                    "Choose above, or type your own answer…".into()
                }
                _ => "Answer the question above…".into(),
            }
        } else if !self.has_chat() {
            "Type to start a new session…".into()
        } else if self.session.busy {
            "Type to queue a follow-up · ⏎ send · ⌥⏎ new line".into()
        } else {
            "Ask anything, or describe a change…   / commands · ! shell".into()
        }
    }

    fn draw(&mut self, term: &mut Term) {
        let size = term.size().unwrap_or_default();
        let area = Rect::new(0, 0, size.width, size.height);
        let overlay = self.theme_picker.as_ref().map(|(row, _)| {
            let lines = self.theme_lines(*row);
            let w = 44.min(area.width);
            let h = (lines.len() as u16 + 2).min(area.height);
            let rect = Rect::new(
                area.width.saturating_sub(w) / 2,
                area.height.saturating_sub(h) / 2,
                w,
                h,
            );
            (
                rect,
                lines,
                self.palette.style(self.palette.border),
                self.palette.bg,
            )
        });
        // The sidebar sits on the left unless hidden or the window is narrow.
        let side = if self.sidebar.visible && area.width >= 72 {
            sidebar::WIDTH.min(area.width / 2)
        } else {
            0
        };
        let inner = Rect::new(
            side + 1,
            0,
            area.width.saturating_sub(side + 2),
            area.height,
        );
        let width = inner.width as usize;
        let status = self.status_line(if self.screen.is_some() {
            area.width.saturating_sub(4) as usize
        } else {
            width
        });

        if let Some(Screen::Projects(page)) = &self.screen {
            let bg = self.palette.bg;
            let palette = &self.palette;
            let server = if self.conn.remote {
                format!("connected to {}", self.conn.label())
            } else {
                format!(
                    "local server {}",
                    self.conn.base_url.trim_start_matches("http://")
                )
            };
            let _ = term.draw(|frame| {
                let buf = frame.buffer_mut();
                buf.set_style(area, Style::default().bg(bg));
                page.draw(buf, area, palette, &server);
                paint_overlay(buf, overlay);
            });
            return;
        }
        if let Some(Screen::Agent(panel)) = &self.screen {
            let cx = screens::Context {
                palette: &self.palette,
                agent_names: &self.agent_names,
                status,
            };
            let bg = self.palette.bg;
            let _ = term.draw(|frame| {
                frame.buffer_mut().set_style(area, Style::default().bg(bg));
                panel.draw(frame.buffer_mut(), area, &cx);
                paint_overlay(frame.buffer_mut(), overlay);
            });
            return;
        }

        // Bottom up: status line, input box, the work line, then whatever
        // floats above the input; the conversation fills the rest.
        let queued: Vec<Line<'static>> = {
            let p = &self.palette;
            let mut rows: Vec<Line<'static>> = self
                .session
                .queue
                .iter()
                .take(2)
                .map(|queued| {
                    Line::from(vec![
                        Span::styled("⏸ queued  ", p.style(p.warn)),
                        Span::styled(
                            screens::fit(
                                queued.text.lines().next().unwrap_or(""),
                                width.saturating_sub(16),
                            ),
                            p.style(p.muted),
                        ),
                    ])
                })
                .collect();
            if self.session.queue.len() > 2 {
                rows.push(Line::from(Span::styled(
                    format!("  + {} more", self.session.queue.len() - 2),
                    p.style(p.faint),
                )));
            }
            rows
        };
        let input_height = screens::input_rows(&self.input, inner.width) + 2 + queued.len() as u16;
        let status_y = area.height.saturating_sub(1);
        let input_y = status_y.saturating_sub(input_height);
        let work_y = input_y.saturating_sub(1);
        let work = self.work_line(width);
        let floating = self.floating(width);
        let float_height = floating
            .as_ref()
            .map(|(lines, _)| (lines.len() as u16 + 2).min(work_y.saturating_sub(3)))
            .unwrap_or(0);
        let float_y = work_y.saturating_sub(float_height);
        let view_height = float_y as usize;

        let live = self.live_lines(width);
        let verbose = self.verbose;
        let palette = self.palette.clone();
        let transcript = self.transcript.lines(width, verbose, &palette);
        let total = transcript.len() + live.len();
        let max_top = total.saturating_sub(view_height);
        let top = self.scroll_top.map(|t| t.min(max_top)).unwrap_or(max_top);
        let shown: Vec<Line<'static>> = transcript
            .iter()
            .chain(live.iter())
            .skip(top)
            .take(view_height)
            .cloned()
            .collect();
        self.view_height = view_height;
        self.view_lines = total;
        if self.scroll_top.is_some_and(|t| t >= max_top) {
            self.scroll_top = None;
        }

        let hint = self.input_hint();
        let p = &self.palette;
        let input = &self.input;
        let welcome = (!self.has_chat()).then(|| self.welcome_lines(view_height));
        let input_focused = !(self.sidebar.focused && side > 0);
        self.sidebar_area = Rect::new(0, 0, side, area.height);
        let sidebar = &self.sidebar;
        let agent_names = &self.agent_names;
        let frame_count = self.frame;
        let _ = term.draw(|frame| {
            let buf = frame.buffer_mut();
            // The theme's background, as the rest of Grove's terminal UI.
            buf.set_style(area, Style::default().bg(p.bg));
            if side > 0 {
                sidebar.draw(
                    buf,
                    Rect::new(0, 0, side, area.height),
                    p,
                    frame_count,
                    agent_names,
                );
            }
            match welcome {
                Some(lines) => Paragraph::new(lines)
                    .alignment(ratatui::layout::Alignment::Center)
                    .render(Rect::new(inner.x, 0, inner.width, view_height as u16), buf),
                None => Paragraph::new(shown)
                    .render(Rect::new(inner.x, 0, inner.width, view_height as u16), buf),
            }
            if let Some((lines, color)) = floating {
                let rect = Rect::new(inner.x, float_y, inner.width, float_height);
                float_box(buf, rect, lines, p.style(color));
                buf.set_style(rect, Style::default().bg(p.bg));
            }
            Paragraph::new(work).render(Rect::new(inner.x, work_y, inner.width, 1), buf);
            let cursor = screens::input_box(
                buf,
                Rect::new(inner.x, input_y, inner.width, input_height),
                p,
                input,
                &hint,
                queued,
                input_focused,
            );
            Paragraph::new(status).render(Rect::new(inner.x, status_y, inner.width, 1), buf);
            let picking = overlay.is_some();
            paint_overlay(buf, overlay);
            if let (Some(position), false) = (cursor, picking) {
                frame.set_cursor_position(position);
            }
        });
    }
}

/// The theme list over everything else, on the theme's ground.
fn paint_overlay(
    buf: &mut ratatui::buffer::Buffer,
    overlay: Option<(Rect, Vec<Line<'static>>, Style, ratatui::style::Color)>,
) {
    let Some((rect, lines, border, bg)) = overlay else {
        return;
    };
    float_box(buf, rect, lines, border);
    for y in rect.y..rect.y + rect.height {
        for x in rect.x..rect.x + rect.width {
            if let Some(cell) = buf.cell_mut((x, y)) {
                if cell.bg == ratatui::style::Color::Reset {
                    cell.set_bg(bg);
                }
            }
        }
    }
}

/// A bordered card over whatever is beneath it; keeps the last lines when
/// it is too short.
fn float_box(
    buf: &mut ratatui::buffer::Buffer,
    rect: Rect,
    lines: Vec<Line<'static>>,
    border: Style,
) {
    for y in rect.y..rect.y + rect.height {
        for x in rect.x..rect.x + rect.width {
            if let Some(cell) = buf.cell_mut((x, y)) {
                cell.reset();
            }
        }
    }
    let block = Frame::default()
        .borders(Borders::ALL)
        .border_type(BorderType::Rounded)
        .border_style(border);
    let body = block.inner(rect);
    block.render(rect, buf);
    let skip = lines.len().saturating_sub(body.height as usize);
    Paragraph::new(lines.into_iter().skip(skip).collect::<Vec<_>>()).render(
        Rect::new(
            body.x + 1,
            body.y,
            body.width.saturating_sub(2),
            body.height,
        ),
        buf,
    );
}

/// Key hints: key in blue, what it does muted.
fn hints(p: &Palette, pairs: &[(&str, &str)]) -> Line<'static> {
    let mut spans = Vec::new();
    for (index, (key, what)) in pairs.iter().enumerate() {
        if index > 0 {
            spans.push(Span::raw("   "));
        }
        if !key.is_empty() {
            spans.push(Span::styled(
                key.to_string(),
                p.style(p.highlight).add_modifier(Modifier::BOLD),
            ));
            spans.push(Span::raw(" "));
        }
        spans.push(Span::styled(what.to_string(), p.style(p.muted)));
    }
    Line::from(spans)
}

/// `left` and `right` on one line, `right` flush right when it fits.
fn spread(mut left: Vec<Span<'static>>, right: Vec<Span<'static>>, width: usize) -> Line<'static> {
    let used: usize = left
        .iter()
        .chain(right.iter())
        .map(|s| unicode_width::UnicodeWidthStr::width(s.content.as_ref()))
        .sum();
    if used < width && !right.is_empty() {
        left.push(Span::raw(" ".repeat(width - used)));
        left.extend(right);
    }
    Line::from(left)
}

pub async fn run(conn: Conn, args: CliArgs) {
    // Resolve the starting target before taking over the terminal, so any
    // error prints plainly.
    // Inside a project: straight to it. Elsewhere: the projects page.
    let project = super::resolve_project(&conn, &args.target)
        .await
        .unwrap_or_else(|e| fail(e));
    let start_on_projects = project.is_none();
    let project = project.unwrap_or_default();
    let task_id = super::default_task(&args.target);
    // `--chat` / `--new` go straight to a session, and so does a task's
    // terminal pane (it resumes that task's latest one); otherwise the
    // sidebar lets the user choose.
    let task_pane = args.target.task.is_none() && std::env::var("GROVE_TASK_ID").is_ok();
    let chat = if args.target.chat.is_some() || args.new || task_pane {
        super::resolve_chat(
            &conn,
            &project,
            &task_id,
            args.target.chat.as_deref(),
            args.new,
            args.agent.as_deref(),
        )
        .await
        .unwrap_or_else(|e| fail(e))
    } else {
        api::Chat::default()
    };
    let target = Target {
        project,
        task_id,
        chat,
    };

    let palette = Palette::load();
    crossterm::terminal::enable_raw_mode().unwrap_or_else(|e| fail(e));
    let _ = crossterm::execute!(
        std::io::stdout(),
        EnterAlternateScreen,
        EnableBracketedPaste,
        EnableMouseCapture
    );
    // Give the terminal back even if something panics.
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        restore_terminal();
        default_hook(info);
    }));
    let mut term = Terminal::new(CrosstermBackend::new(std::io::stdout())).unwrap_or_else(|e| {
        restore_terminal();
        fail(e)
    });

    let (events_tx, mut events_rx) = mpsc::unbounded_channel();
    let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    {
        let tx = events_tx.clone();
        let stop = stop.clone();
        std::thread::spawn(move || {
            while !stop.load(std::sync::atomic::Ordering::Relaxed) {
                if !event::poll(Duration::from_millis(100)).unwrap_or(false) {
                    continue;
                }
                let sent = match event::read() {
                    Ok(Event::Key(key)) => tx.send(AppEvent::Key(key)),
                    Ok(Event::Paste(text)) => tx.send(AppEvent::Paste(text)),
                    Ok(Event::Resize(_, _)) => tx.send(AppEvent::Resize),
                    Ok(Event::Mouse(mouse)) => match mouse.kind {
                        MouseEventKind::ScrollUp => tx.send(AppEvent::Scroll(-3, mouse.column)),
                        MouseEventKind::ScrollDown => tx.send(AppEvent::Scroll(3, mouse.column)),
                        MouseEventKind::Down(crossterm::event::MouseButton::Left) => {
                            tx.send(AppEvent::Click(mouse.column, mouse.row))
                        }
                        _ => Ok(()),
                    },
                    _ => Ok(()),
                };
                if sent.is_err() {
                    break;
                }
            }
        });
    }
    {
        let tx = events_tx.clone();
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(Duration::from_millis(120));
            loop {
                tick.tick().await;
                if tx.send(AppEvent::Tick).is_err() {
                    break;
                }
            }
        });
    }

    let mut app = App {
        palette: palette.clone(),
        target: target.clone(),
        session: Session::default(),
        flushed: 0,
        transcript: Transcript::default(),
        scroll_top: None,
        view_height: 0,
        view_lines: 0,
        input: Input::default(),
        screen: None,
        queue_picker: None,
        permission_row: (String::new(), 0),
        draft: None,
        menu_selected: 0,
        verbose: false,
        quit_armed: None,
        flash: None,
        pending_config: None,
        frame: 0,
        generation: 0,
        out: None,
        reader: None,
        events: events_tx,
        quit: false,
        agent_names: HashMap::new(),
        reconnecting: None,
        pending_prompt: None,
        sidebar: Sidebar::new(target.project.clone()),
        buddy: None,
        sidebar_area: Rect::default(),
        theme_picker: None,
        shell_request: None,
        conn,
    };
    app.load_agent_names().await;
    if app.has_chat() {
        app.open(target).await;
        app.focus_chat();
    } else if app.target.task_id != api::LOCAL_TASK_ID {
        let task = sidebar::Row::NewSession(app.target.task_id.clone());
        app.sidebar.expanded.insert(app.target.task_id.clone());
        app.sidebar.select(&task);
    }
    if start_on_projects {
        app.open_projects().await;
    } else {
        app.refresh_sidebar();
    }
    app.draw(&mut term);

    while let Some(event) = events_rx.recv().await {
        match event {
            AppEvent::Key(key) => app.on_key(key).await,
            AppEvent::Paste(text) => {
                if app.screen.is_none() && !(app.sidebar.focused && app.sidebar.visible) {
                    app.input.insert_str(&text);
                }
            }
            AppEvent::Sidebar(data) => app.apply_sidebar(*data),
            AppEvent::Resize => {
                let _ = term.autoresize();
            }
            AppEvent::Scroll(delta, x) => {
                if app.screen.is_none() {
                    if x < app.sidebar_area.width {
                        // Over the sidebar: move through its cards.
                        let key = if delta < 0 {
                            KeyCode::Up
                        } else {
                            KeyCode::Down
                        };
                        app.sidebar.focused = true;
                        app.sidebar.key(KeyEvent::from(key));
                    } else {
                        app.scroll(delta);
                    }
                }
            }
            AppEvent::Click(x, y) => app.click(x, y).await,
            AppEvent::Server { generation, value } if generation == app.generation => {
                app.on_server(value);
            }
            AppEvent::Closed { generation } if generation == app.generation => {
                app.start_reconnect();
            }
            AppEvent::Reconnect { generation } if generation == app.generation => {
                app.reconnect().await;
            }
            AppEvent::Tick => {
                app.frame = app.frame.wrapping_add(1);
                // Keep the sidebar's states current (about every 5s).
                if app.frame.is_multiple_of(40) {
                    app.refresh_sidebar();
                }
                if app
                    .flash
                    .as_ref()
                    .is_some_and(|(_, at)| at.elapsed() > Duration::from_secs(4))
                {
                    app.flash = None;
                }
            }
            _ => {}
        }
        if app.quit {
            break;
        }
        if let Some(dir) = app.shell_request.take() {
            // Hand the terminal to a shell in the task's directory.
            restore_terminal();
            println!("Shell in {dir} — exit to return to Grove.");
            let shell = crate::platform::interactive_shell();
            let _ = std::process::Command::new(shell).current_dir(&dir).status();
            let _ = crossterm::terminal::enable_raw_mode();
            let _ = crossterm::execute!(
                std::io::stdout(),
                EnterAlternateScreen,
                EnableBracketedPaste,
                EnableMouseCapture
            );
            let _ = term.clear();
        }
        app.draw(&mut term);
    }

    stop.store(true, std::sync::atomic::Ordering::Relaxed);
    if let Some(reader) = app.reader.take() {
        reader.abort();
    }
    restore_terminal();
    if app.has_chat() {
        println!(
            "Left {} — it keeps running on the server. Resume with `grove cli --chat {}`.",
            app.target.chat.title, app.target.chat.id
        );
    }
}

fn restore_terminal() {
    let _ = crossterm::execute!(
        std::io::stdout(),
        DisableMouseCapture,
        DisableBracketedPaste,
        LeaveAlternateScreen,
        crossterm::cursor::Show
    );
    let _ = crossterm::terminal::disable_raw_mode();
}

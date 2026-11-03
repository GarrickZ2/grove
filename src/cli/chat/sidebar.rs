//! The sidebar: the same hierarchy as the GUI's Orbit sidebar — a project
//! switcher, the project's own sessions, its tasks (each with its sessions)
//! and the Buddies. Navigation and simple management happen here; talking
//! happens in the chat beside it.

use std::collections::{HashMap, HashSet};

use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Paragraph, Widget};

use super::api;
use super::input::Input;
use super::render::Palette;
use super::screens::{fit, pad};

pub const WIDTH: u16 = 42;

/// A row of the sidebar.
#[derive(Clone, PartialEq)]
pub enum Row {
    /// The current project; opens the project list.
    Switch,
    Header(&'static str),
    Session {
        task_id: String,
        chat_id: String,
    },
    Task(String),
    NewSession(String),
    Buddy(usize),
}

/// A question the sidebar asks before acting.
pub enum Prompt {
    NewTask(Input),
    RenameTask(String, Input),
    RenameSession {
        task_id: String,
        chat_id: String,
        input: Input,
    },
    /// Archive, with the server's reason when a plain archive was refused.
    ArchiveTask {
        task_id: String,
        reason: Option<String>,
    },
    ArchiveSession {
        task_id: String,
        chat_id: String,
    },
}

/// What the app should do after a sidebar key.
pub enum Action {
    Stay,
    /// Hand the keyboard back to the chat.
    Leave,
    Open {
        project_id: String,
        task_id: String,
        chat_id: String,
    },
    NewSession {
        project_id: String,
        task_id: String,
    },
    /// Back to the projects page.
    ShowProjects,
    NewTask(String),
    RenameTask(String, String),
    RenameSession {
        task_id: String,
        chat_id: String,
        title: String,
    },
    ArchiveTask {
        task_id: String,
        force: bool,
    },
    ArchiveSession {
        task_id: String,
        chat_id: String,
    },
    Pin {
        task_id: String,
        chat_id: String,
        pinned: bool,
    },
    Info,
    /// Talk to a Buddy: its session lives in its own project's Local Task.
    OpenBuddy {
        name: String,
        project_id: String,
        chat_id: String,
    },
}

/// What the sidebar lists.
#[derive(Clone, Copy, PartialEq)]
pub enum View {
    /// The current project: its sessions and tasks.
    Project,
    /// The Buddies, while talking to one.
    Buddies,
}

pub struct Sidebar {
    pub visible: bool,
    pub focused: bool,
    pub project: api::ProjectDetail,
    pub projects: Vec<api::Project>,
    /// Sessions by task id.
    pub sessions: HashMap<String, Vec<api::Chat>>,
    /// Live state by chat id: `busy` or `permission_required`.
    pub active: HashMap<String, String>,
    pub buddies: Vec<api::Buddy>,
    pub expanded: HashSet<String>,
    pub cursor: usize,
    pub view: View,
    pub prompt: Option<Prompt>,
    /// The open session, marked in the list: (task id, chat id).
    pub here: Option<(String, String)>,
}

impl Sidebar {
    pub fn new(project: api::ProjectDetail) -> Self {
        Self {
            visible: true,
            focused: true,
            project,
            projects: Vec::new(),
            sessions: HashMap::new(),
            active: HashMap::new(),
            buddies: Vec::new(),
            expanded: HashSet::new(),
            cursor: 0,
            view: View::Project,
            prompt: None,
            here: None,
        }
    }

    pub fn rows(&self) -> Vec<Row> {
        let mut rows = Vec::new();
        if self.view == View::Buddies {
            rows.push(Row::Switch);
            rows.push(Row::Header("Buddies"));
            rows.extend((0..self.buddies.len()).map(Row::Buddy));
            return rows;
        }
        rows.push(Row::Switch);
        rows.push(Row::Header("Sessions"));
        let local = api::LOCAL_TASK_ID.to_string();
        rows.extend(self.session_rows(&local));
        rows.push(Row::NewSession(local));
        let tasks: Vec<api::Task> = self.project.chat_tasks().into_iter().skip(1).collect();
        if !tasks.is_empty() {
            rows.push(Row::Header("Tasks"));
            for task in tasks {
                rows.push(Row::Task(task.id.clone()));
                if self.expanded.contains(&task.id) {
                    rows.extend(self.session_rows(&task.id));
                    rows.push(Row::NewSession(task.id));
                }
            }
        }
        rows
    }

    fn session_rows(&self, task_id: &str) -> Vec<Row> {
        self.sessions
            .get(task_id)
            .map(|chats| {
                chats
                    .iter()
                    .map(|chat| Row::Session {
                        task_id: task_id.to_string(),
                        chat_id: chat.id.clone(),
                    })
                    .collect()
            })
            .unwrap_or_default()
    }

    fn chat(&self, task_id: &str, chat_id: &str) -> Option<&api::Chat> {
        self.sessions.get(task_id)?.iter().find(|c| c.id == chat_id)
    }

    pub fn task(&self, task_id: &str) -> Option<api::Task> {
        self.project
            .chat_tasks()
            .into_iter()
            .find(|task| task.id == task_id)
    }

    /// Put the cursor on `row` when it is in the list.
    pub fn select(&mut self, row: &Row) {
        if let Some(index) = self.rows().iter().position(|r| r == row) {
            self.cursor = index;
        }
    }

    /// Keep the cursor on a selectable row after the list changed.
    pub fn clamp(&mut self) {
        let rows = self.rows();
        self.cursor = self.cursor.min(rows.len().saturating_sub(1));
        if matches!(rows.get(self.cursor), Some(Row::Header(_))) {
            self.cursor = (self.cursor + 1).min(rows.len().saturating_sub(1));
        }
    }

    fn step(&mut self, down: bool) {
        let rows = self.rows();
        let mut next = self.cursor;
        loop {
            next = if down {
                if next + 1 >= rows.len() {
                    return;
                }
                next + 1
            } else {
                match next.checked_sub(1) {
                    Some(n) => n,
                    None => return,
                }
            };
            if !matches!(rows[next], Row::Header(_)) {
                self.cursor = next;
                return;
            }
        }
    }

    /// The task a row belongs to, for "new session" and the like.
    fn row_task(&self, row: &Row) -> String {
        match row {
            Row::Session { task_id, .. } | Row::Task(task_id) | Row::NewSession(task_id) => {
                task_id.clone()
            }
            _ => api::LOCAL_TASK_ID.to_string(),
        }
    }

    fn prompt_key(&mut self, key: KeyEvent) -> Action {
        let Some(prompt) = self.prompt.as_mut() else {
            return Action::Stay;
        };
        if let Prompt::ArchiveTask { task_id, reason } = prompt {
            let task_id = task_id.clone();
            let force = reason.is_some();
            return match key.code {
                KeyCode::Char('y') | KeyCode::Enter => {
                    self.prompt = None;
                    Action::ArchiveTask { task_id, force }
                }
                _ => {
                    self.prompt = None;
                    Action::Stay
                }
            };
        }
        if let Prompt::ArchiveSession { task_id, chat_id } = prompt {
            let (task_id, chat_id) = (task_id.clone(), chat_id.clone());
            self.prompt = None;
            return match key.code {
                KeyCode::Char('y') | KeyCode::Enter => Action::ArchiveSession { task_id, chat_id },
                _ => Action::Stay,
            };
        }
        let input = match prompt {
            Prompt::NewTask(input)
            | Prompt::RenameTask(_, input)
            | Prompt::RenameSession { input, .. } => input,
            _ => unreachable!(),
        };
        let ctrl = key.modifiers.contains(KeyModifiers::CONTROL);
        match key.code {
            KeyCode::Esc => self.prompt = None,
            KeyCode::Enter => {
                let text = input.text().trim().to_string();
                let prompt = self.prompt.take();
                if text.is_empty() {
                    return Action::Stay;
                }
                return match prompt {
                    Some(Prompt::NewTask(_)) => Action::NewTask(text),
                    Some(Prompt::RenameTask(task_id, _)) => Action::RenameTask(task_id, text),
                    Some(Prompt::RenameSession {
                        task_id, chat_id, ..
                    }) => Action::RenameSession {
                        task_id,
                        chat_id,
                        title: text,
                    },
                    _ => Action::Stay,
                };
            }
            KeyCode::Backspace => input.backspace(),
            KeyCode::Left => input.left(),
            KeyCode::Right => input.right(),
            KeyCode::Char('u') if ctrl => input.kill_to_start(),
            KeyCode::Char(ch) if !ctrl => input.insert(ch),
            _ => {}
        }
        Action::Stay
    }

    pub fn key(&mut self, key: KeyEvent) -> Action {
        if self.prompt.is_some() {
            return self.prompt_key(key);
        }
        let rows = self.rows();
        let row = rows.get(self.cursor).cloned();
        let project_id = self.project.id.clone();
        match key.code {
            KeyCode::Up | KeyCode::Char('k') => self.step(false),
            KeyCode::Down | KeyCode::Char('j') => self.step(true),
            KeyCode::Esc => return Action::Leave,
            KeyCode::Right | KeyCode::Char('l') => {
                if let Some(Row::Task(id)) = &row {
                    self.expanded.insert(id.clone());
                }
            }
            KeyCode::Left | KeyCode::Char('h') => match &row {
                Some(Row::Task(id)) => {
                    self.expanded.remove(id);
                }
                Some(Row::Session { task_id, .. } | Row::NewSession(task_id))
                    if task_id != api::LOCAL_TASK_ID =>
                {
                    let task = Row::Task(task_id.clone());
                    self.expanded.remove(task_id);
                    self.select(&task);
                }
                _ => {}
            },
            KeyCode::Enter => match row {
                Some(Row::Switch) => return Action::ShowProjects,
                Some(Row::Session { task_id, chat_id }) => {
                    return Action::Open {
                        project_id,
                        task_id,
                        chat_id,
                    }
                }
                Some(Row::Task(id)) => {
                    if !self.expanded.remove(&id) {
                        self.expanded.insert(id);
                    }
                }
                Some(Row::NewSession(task_id)) => {
                    return Action::NewSession {
                        project_id,
                        task_id,
                    }
                }
                Some(Row::Buddy(index)) => {
                    if let Some(buddy) = self.buddies.get(index) {
                        if let Some(chat_id) = buddy.active_session_id.clone() {
                            return Action::OpenBuddy {
                                name: buddy.name.clone(),
                                project_id: buddy.project_hash.clone(),
                                chat_id,
                            };
                        }
                    }
                }
                _ => {}
            },
            // Managing sessions and tasks belongs to the project view.
            KeyCode::Char('n' | 't' | 'r' | 'a' | 'p') if self.view != View::Project => {}
            KeyCode::Char('n') => {
                if let Some(row) = &row {
                    return Action::NewSession {
                        project_id,
                        task_id: self.row_task(row),
                    };
                }
            }
            KeyCode::Char('t') => {
                self.prompt = Some(Prompt::NewTask(Input::default()));
            }
            KeyCode::Char('r') => match &row {
                Some(Row::Session { task_id, chat_id }) => {
                    let mut input = Input::default();
                    if let Some(chat) = self.chat(task_id, chat_id) {
                        input.set(&chat.title);
                    }
                    self.prompt = Some(Prompt::RenameSession {
                        task_id: task_id.clone(),
                        chat_id: chat_id.clone(),
                        input,
                    });
                }
                Some(Row::Task(id)) => {
                    let mut input = Input::default();
                    if let Some(task) = self.task(id) {
                        input.set(&task.name);
                    }
                    self.prompt = Some(Prompt::RenameTask(id.clone(), input));
                }
                _ => {}
            },
            KeyCode::Char('a') => match &row {
                Some(Row::Session { task_id, chat_id }) => {
                    self.prompt = Some(Prompt::ArchiveSession {
                        task_id: task_id.clone(),
                        chat_id: chat_id.clone(),
                    });
                }
                Some(Row::Task(id)) => {
                    self.prompt = Some(Prompt::ArchiveTask {
                        task_id: id.clone(),
                        reason: None,
                    });
                }
                _ => {}
            },
            KeyCode::Char('p') => {
                if let Some(Row::Session { task_id, chat_id }) = &row {
                    let pinned = self.chat(task_id, chat_id).is_some_and(|chat| chat.pinned);
                    return Action::Pin {
                        task_id: task_id.clone(),
                        chat_id: chat_id.clone(),
                        pinned: !pinned,
                    };
                }
            }
            KeyCode::Char('i') => return Action::Info,
            _ => {}
        }
        Action::Stay
    }

    // ── Drawing ────────────────────────────────────────────────────────────

    /// Height of a row's card.
    fn height(&self, row: &Row) -> u16 {
        match row {
            Row::Switch => 3,
            Row::Header(_) => 2,
            Row::Session { .. } | Row::Task(_) | Row::Buddy(_) => 2,
            Row::NewSession(_) => 1,
        }
    }

    /// The list area inside the sidebar (above its footer).
    fn list_area(area: Rect) -> Rect {
        Rect::new(
            area.x + 1,
            area.y + 1,
            area.width.saturating_sub(3),
            area.height.saturating_sub(5),
        )
    }

    /// Visible rows: (row index, y, height), scrolled so the cursor shows.
    fn layout(&self, list: Rect) -> Vec<(usize, u16, u16)> {
        let rows = self.rows();
        let mut y = 0u16;
        let mut placed = Vec::new();
        let mut cursor_end = 0;
        for (index, row) in rows.iter().enumerate() {
            let h = self.height(row);
            placed.push((index, y, h));
            if index == self.cursor {
                cursor_end = y + h;
            }
            y += h;
        }
        let offset = cursor_end.saturating_sub(list.height);
        placed
            .into_iter()
            .filter(|(_, y, h)| *y >= offset && *y + *h - offset <= list.height)
            .map(|(index, y, h)| (index, list.y + y - offset, h))
            .collect()
    }

    /// The row under a click.
    pub fn hit(&self, area: Rect, y: u16) -> Option<usize> {
        let rows = self.rows();
        self.layout(Self::list_area(area))
            .into_iter()
            .find(|(index, top, h)| {
                y >= *top && y < *top + *h && !matches!(rows[*index], Row::Header(_))
            })
            .map(|(index, _, _)| index)
    }

    pub fn draw(
        &self,
        buf: &mut Buffer,
        area: Rect,
        p: &Palette,
        frame: usize,
        names: &HashMap<String, String>,
    ) {
        // The theme's background with a border on the right, as the TUI.
        buf.set_style(area, Style::default().bg(p.bg));
        let edge = area.x + area.width.saturating_sub(1);
        for y in area.y..area.y + area.height {
            if let Some(cell) = buf.cell_mut((edge, y)) {
                cell.set_symbol("│").set_style(p.style(p.border));
            }
        }
        let list = Self::list_area(area);
        let rows = self.rows();
        let w = list.width as usize;
        for (index, top, h) in self.layout(list) {
            let selected = index == self.cursor;
            let lines = self.card(&rows[index], selected, w, p, frame, names);
            let card = Rect::new(list.x, top, list.width, h);
            let highlighted = selected && self.focused && !matches!(rows[index], Row::Header(_));
            if highlighted {
                let used = if matches!(rows[index], Row::Switch) {
                    h - 1
                } else {
                    h
                };
                buf.set_style(
                    Rect::new(card.x, card.y, card.width, used),
                    Style::default().bg(p.panel),
                );
            }
            Paragraph::new(lines).render(card, buf);
        }

        // Footer: the prompt, or keys for the highlighted row.
        let footer = Rect::new(
            list.x,
            area.y + area.height.saturating_sub(4),
            list.width,
            3,
        );
        let lines = match &self.prompt {
            Some(prompt) => self.prompt_lines(prompt, w, p),
            None if self.focused => self.key_lines(rows.get(self.cursor), p),
            None => vec![
                Line::default(),
                Line::default(),
                Line::from(vec![
                    Span::styled("⌃B", p.style(p.highlight).add_modifier(Modifier::BOLD)),
                    Span::styled(" sidebar", p.style(p.muted)),
                ]),
            ],
        };
        Paragraph::new(lines).render(footer, buf);
    }

    /// The lines of one card. `w` is the card width.
    fn card(
        &self,
        row: &Row,
        selected: bool,
        w: usize,
        p: &Palette,
        frame: usize,
        names: &HashMap<String, String>,
    ) -> Vec<Line<'static>> {
        let pointer = || {
            Span::styled(
                if selected { "❯ " } else { "  " },
                p.style(p.highlight).add_modifier(Modifier::BOLD),
            )
        };
        let name_style = |bold: bool| {
            let style = if selected {
                p.style(p.highlight)
            } else {
                p.style(p.text)
            };
            if bold {
                style.add_modifier(Modifier::BOLD)
            } else {
                style
            }
        };
        let here_chat = |chat_id: &str| self.here.as_ref().is_some_and(|(_, c)| c == chat_id);
        // `left` padded so `right` sits at the card's right edge.
        let spread = |left: Vec<Span<'static>>, right: Span<'static>| {
            let used: usize =
                left.iter().map(|s| width_of(&s.content)).sum::<usize>() + width_of(&right.content);
            let mut spans = left;
            spans.push(Span::raw(" ".repeat(w.saturating_sub(used))));
            spans.push(right);
            Line::from(spans)
        };
        match row {
            Row::Switch => {
                let (title, detail, index) = if self.view == View::Buddies {
                    ("Buddies".to_string(), "all projects ›".to_string(), 7)
                } else {
                    let tasks = self.project.chat_tasks().len().saturating_sub(1);
                    let kind = if self.project.project_type == "studio" {
                        "studio"
                    } else {
                        "repo"
                    };
                    (
                        self.project.name.clone(),
                        format!("{kind} · {tasks} task{}", if tasks == 1 { "" } else { "s" }),
                        0,
                    )
                };
                let block = |row| super::screens::block_row_n(row, p, index, 4);
                let mut first = block(0);
                first.push(Span::raw("  "));
                first.push(Span::styled(
                    pad(&title, w.saturating_sub(9)),
                    name_style(true),
                ));
                first.push(Span::styled(" ▾", p.style(p.muted)));
                let mut second = block(1);
                second.push(Span::raw("  "));
                second.push(Span::styled(
                    fit(&detail, w.saturating_sub(6)),
                    p.style(p.muted),
                ));
                vec![Line::from(first), Line::from(second)]
            }
            Row::Header(name) => vec![
                Line::default(),
                Line::from(Span::styled(
                    format!("  {}", name.to_uppercase()),
                    p.style(p.muted).add_modifier(Modifier::BOLD),
                )),
            ],
            Row::Session { task_id, chat_id } => {
                let Some(chat) = self.chat(task_id, chat_id) else {
                    return vec![Line::default(), Line::default()];
                };
                let indent = if task_id == api::LOCAL_TASK_ID {
                    ""
                } else {
                    "  "
                };
                let state = self.active.get(chat_id).map(String::as_str).unwrap_or("");
                let (mark, color) = match state {
                    "busy" => (spin(frame), p.info),
                    "permission_required" => ("◆", p.warn),
                    _ if here_chat(chat_id) => ("●", p.accent),
                    _ => ("○", p.muted),
                };
                let ago = super::commands::ago(chat.last_active());
                let pin = if chat.pinned { "⇡ " } else { "" };
                let title_w = w.saturating_sub(indent.len() + 4 + pin.len() + 5);
                let agent = names
                    .get(&chat.agent)
                    .cloned()
                    .unwrap_or_else(|| chat.agent.clone());
                let state_text = match state {
                    "busy" => Span::styled(" · running", p.style(p.info)),
                    "permission_required" => Span::styled(" · needs you", p.style(p.warn)),
                    _ => Span::raw(""),
                };
                vec![
                    spread(
                        vec![
                            Span::raw(indent),
                            pointer(),
                            Span::styled(format!("{mark} "), p.style(color)),
                            Span::styled(pin, p.style(p.muted)),
                            Span::styled(fit(&chat.title, title_w), name_style(here_chat(chat_id))),
                        ],
                        Span::styled(ago, p.style(p.muted)),
                    ),
                    Line::from(vec![
                        Span::raw(format!("{indent}    ")),
                        Span::styled(
                            fit(&agent, w.saturating_sub(indent.len() + 18)),
                            p.style(p.muted),
                        ),
                        state_text,
                    ]),
                ]
            }
            Row::Task(id) => {
                let task = self.task(id);
                let open = self.expanded.contains(id);
                let name = task.as_ref().map(|t| t.name.clone()).unwrap_or_default();
                let count = self.sessions.get(id).map(|c| c.len()).unwrap_or(0);
                let mut detail = vec![];
                if let Some(task) = &task {
                    if !task.branch.is_empty() {
                        detail.push(Span::styled(
                            if task.target.is_empty() {
                                task.branch.clone()
                            } else {
                                format!("{} → {}", task.branch, task.target)
                            },
                            p.style(p.muted),
                        ));
                    }
                    match task.status.as_str() {
                        "conflict" | "broken" => detail
                            .push(Span::styled(format!(" · {}", task.status), p.style(p.warn))),
                        "merged" => detail.push(Span::styled(" · merged", p.style(p.accent))),
                        _ => {}
                    }
                }
                let detail_w = w.saturating_sub(4);
                let detail: Vec<Span<'static>> = {
                    let text: String = detail.iter().map(|s| s.content.to_string()).collect();
                    if width_of(&text) > detail_w {
                        vec![Span::styled(fit(&text, detail_w), p.style(p.muted))]
                    } else {
                        detail
                    }
                };
                let mut second = vec![Span::raw("    ")];
                second.extend(detail);
                vec![
                    spread(
                        vec![
                            pointer(),
                            Span::styled(if open { "▾ " } else { "▸ " }, p.style(p.muted)),
                            Span::styled(fit(&name, w.saturating_sub(10)), name_style(true)),
                        ],
                        Span::styled(
                            if count > 0 {
                                count.to_string()
                            } else {
                                String::new()
                            },
                            p.style(p.muted),
                        ),
                    ),
                    Line::from(second),
                ]
            }
            Row::NewSession(task_id) => {
                let indent = if task_id == api::LOCAL_TASK_ID {
                    ""
                } else {
                    "  "
                };
                vec![Line::from(vec![
                    Span::raw(indent),
                    pointer(),
                    Span::styled("+ ", p.style(p.highlight)),
                    Span::styled("New session", name_style(false)),
                ])]
            }
            Row::Buddy(index) => {
                let Some(buddy) = self.buddies.get(*index) else {
                    return vec![Line::default(), Line::default()];
                };
                let here = buddy.active_session_id.as_deref().is_some_and(here_chat);
                let state = if buddy.waiting_delegations > 0 {
                    Span::styled(
                        format!("{} waiting", buddy.waiting_delegations),
                        p.style(p.warn),
                    )
                } else {
                    Span::styled(buddy.status.clone(), p.style(p.muted))
                };
                vec![
                    spread(
                        vec![
                            pointer(),
                            Span::styled(
                                if here { "● " } else { "◈ " },
                                p.style(if here { p.accent } else { p.agent }),
                            ),
                            Span::styled(fit(&buddy.name, w.saturating_sub(18)), name_style(true)),
                        ],
                        state,
                    ),
                    Line::from(vec![
                        Span::raw("    "),
                        Span::styled(
                            fit(
                                buddy
                                    .role
                                    .as_deref()
                                    .filter(|r| !r.is_empty())
                                    .unwrap_or(&buddy.description),
                                w.saturating_sub(4),
                            ),
                            p.style(p.muted),
                        ),
                    ]),
                ]
            }
        }
    }

    fn key_lines(&self, row: Option<&Row>, p: &Palette) -> Vec<Line<'static>> {
        let pairs: &[(&str, &str)] = match row {
            Some(Row::Session { .. }) => &[
                ("⏎", "open"),
                ("r", "rename"),
                ("a", "archive"),
                ("p", "pin"),
            ],
            Some(Row::Task(_)) => &[
                ("⏎", "expand"),
                ("n", "new session"),
                ("r", "rename"),
                ("a", "archive"),
            ],
            Some(Row::Switch) => &[("⏎", "all projects"), ("t", "new task")],
            Some(Row::Buddy(_)) => &[("⏎", "talk")],
            _ => &[("⏎", "open"), ("n", "new session"), ("t", "new task")],
        };
        let keys = |pairs: &[(&str, &str)]| {
            let mut spans = Vec::new();
            for (key, what) in pairs {
                spans.push(Span::styled(
                    key.to_string(),
                    p.style(p.highlight).add_modifier(Modifier::BOLD),
                ));
                spans.push(Span::styled(format!(" {what}  "), p.style(p.muted)));
            }
            Line::from(spans)
        };
        vec![
            keys(&pairs[..pairs.len().min(2)]),
            keys(pairs.get(2..).unwrap_or(&[])),
            keys(&[("esc", "chat"), ("i", "info")]),
        ]
    }

    fn prompt_lines(&self, prompt: &Prompt, w: usize, p: &Palette) -> Vec<Line<'static>> {
        let field = |title: &str, input: &Input| {
            vec![
                Line::from(Span::styled(
                    title.to_string(),
                    p.style(p.text).add_modifier(Modifier::BOLD),
                )),
                Line::from(vec![
                    Span::styled("❯ ", p.style(p.accent)),
                    Span::styled(fit(&input.text(), w.saturating_sub(3)), p.style(p.text)),
                    Span::styled("▏", p.style(p.accent)),
                ]),
                Line::from(vec![
                    Span::styled("⏎", p.style(p.highlight).add_modifier(Modifier::BOLD)),
                    Span::styled(" save  ", p.style(p.muted)),
                    Span::styled("esc", p.style(p.highlight).add_modifier(Modifier::BOLD)),
                    Span::styled(" cancel", p.style(p.muted)),
                ]),
            ]
        };
        let confirm = |question: String, detail: Option<&str>| {
            vec![
                Line::from(Span::styled(
                    fit(&question, w),
                    p.style(p.warn).add_modifier(Modifier::BOLD),
                )),
                Line::from(Span::styled(fit(detail.unwrap_or(""), w), p.style(p.muted))),
                Line::from(vec![
                    Span::styled("y", p.style(p.highlight).add_modifier(Modifier::BOLD)),
                    Span::styled(" archive  ", p.style(p.muted)),
                    Span::styled("n", p.style(p.highlight).add_modifier(Modifier::BOLD)),
                    Span::styled(" keep", p.style(p.muted)),
                ]),
            ]
        };
        match prompt {
            Prompt::NewTask(input) => field("New task name", input),
            Prompt::RenameTask(_, input) => field("Rename task", input),
            Prompt::RenameSession { input, .. } => field("Rename session", input),
            Prompt::ArchiveTask { task_id, reason } => {
                let name = self.task(task_id).map(|t| t.name).unwrap_or_default();
                match reason {
                    Some(reason) => confirm(format!("Archive {name} anyway?"), Some(reason)),
                    None => confirm(format!("Archive {name}?"), Some("Removes its worktree")),
                }
            }
            Prompt::ArchiveSession { task_id, chat_id } => {
                let title = self
                    .chat(task_id, chat_id)
                    .map(|c| c.title.clone())
                    .unwrap_or_default();
                confirm(format!("Archive {title}?"), Some("Restore it from the GUI"))
            }
        }
    }
}

fn width_of(text: &str) -> usize {
    unicode_width::UnicodeWidthStr::width(text)
}

fn spin(frame: usize) -> &'static str {
    const FRAMES: [&str; 4] = ["◐", "◓", "◑", "◒"];
    FRAMES[frame % FRAMES.len()]
}

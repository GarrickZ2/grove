//! Full-screen pages of `grove cli`, drawn on the terminal's alternate
//! screen so the conversation's scrollback underneath stays untouched: the
//! start page, the target switcher and the agent / model / mode panel.

use std::collections::HashMap;

use crossterm::event::{KeyCode, KeyEvent};
use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, BorderType, Borders, Paragraph, Widget};
use unicode_width::UnicodeWidthStr;

use super::api;
use super::input::Input;
use super::model::{Choice, Settings};
use super::render::Palette;

/// What a page asks the app to do after a key.
pub enum Action {
    Stay,
    Close,
    New {
        project_id: String,
        task_id: String,
        agent: Option<String>,
    },
    Mode(String),
    Model(String),
    Thought(String),
}

pub enum Screen {
    Agent(Box<AgentPanel>),
    Projects(Box<ProjectsPage>),
}

/// Facts every page shows.
pub struct Context<'a> {
    pub palette: &'a Palette,
    pub agent_names: &'a HashMap<String, String>,
    pub status: Line<'static>,
}

impl Context<'_> {
    fn agent(&self, id: &str) -> String {
        self.agent_names
            .get(id)
            .cloned()
            .unwrap_or_else(|| id.to_string())
    }
}

// ── Shared drawing ─────────────────────────────────────────────────────────

fn width(text: &str) -> usize {
    UnicodeWidthStr::width(text)
}

/// `text` cut to `max` columns, with an ellipsis when cut.
pub fn fit(text: &str, max: usize) -> String {
    if width(text) <= max {
        return text.to_string();
    }
    let mut out = String::new();
    for ch in text.chars() {
        if width(&out) + unicode_width::UnicodeWidthChar::width(ch).unwrap_or(0) + 1 > max {
            break;
        }
        out.push(ch);
    }
    out.push('…');
    out
}

/// `text` cut or padded to exactly `columns`.
pub fn pad(text: &str, columns: usize) -> String {
    let text = fit(text, columns);
    let gap = columns.saturating_sub(width(&text));
    format!("{text}{}", " ".repeat(gap))
}

fn panel(p: &Palette, focused: bool) -> Block<'static> {
    Block::default()
        .borders(Borders::ALL)
        .border_type(BorderType::Rounded)
        .border_style(if focused {
            p.style(p.border)
        } else {
            p.style(p.faint)
        })
}

fn keys(p: &Palette, pairs: &[(&str, &str)]) -> Line<'static> {
    let mut spans = Vec::new();
    for (index, (key, what)) in pairs.iter().enumerate() {
        if index > 0 {
            spans.push(Span::raw("   "));
        }
        spans.push(Span::styled(key.to_string(), p.style(p.info)));
        spans.push(Span::styled(format!(" {what}"), p.style(p.muted)));
    }
    Line::from(spans)
}

fn label(p: &Palette, text: &str) -> Line<'static> {
    Line::from(Span::styled(
        text.to_uppercase(),
        p.style(p.muted).add_modifier(Modifier::BOLD),
    ))
}

fn line_at(buf: &mut Buffer, area: Rect, y: u16, line: Line<'static>) {
    if y >= area.y + area.height {
        return;
    }
    Paragraph::new(line).render(Rect::new(area.x, y, area.width, 1), buf);
}

/// The input box with the prompt and a placeholder; returns where the
/// cursor goes. Shared with the inline chat view.
pub fn input_box(
    buf: &mut Buffer,
    area: Rect,
    p: &Palette,
    input: &Input,
    hint: &str,
    above: Vec<Line<'static>>,
    focused: bool,
) -> Option<(u16, u16)> {
    let block = panel(p, focused);
    let inner = block.inner(area);
    block.render(area, buf);
    let mut y = inner.y;
    for line in above {
        line_at(
            buf,
            Rect::new(
                inner.x + 1,
                inner.y,
                inner.width.saturating_sub(2),
                inner.height,
            ),
            y,
            line,
        );
        y += 1;
    }
    let text_area = Rect::new(
        inner.x + 1,
        y,
        inner.width.saturating_sub(2),
        (inner.y + inner.height).saturating_sub(y),
    );
    let prompt = Span::styled("❯ ", p.style(p.accent).add_modifier(Modifier::BOLD));
    if input.is_empty() {
        Paragraph::new(Line::from(vec![
            prompt,
            Span::styled(hint.to_string(), p.style(p.faint)),
        ]))
        .render(text_area, buf);
        return focused.then_some((text_area.x + 2, text_area.y));
    }
    let (rows, cursor) = input.layout((text_area.width as usize).saturating_sub(2));
    let visible = text_area.height.max(1) as usize;
    let scroll = cursor.1.saturating_sub(visible - 1);
    let lines: Vec<Line> = rows
        .iter()
        .enumerate()
        .skip(scroll)
        .take(visible)
        .map(|(index, row)| {
            Line::from(vec![
                if index == 0 {
                    prompt.clone()
                } else {
                    Span::raw("  ")
                },
                Span::styled(row.clone(), p.style(p.text)),
            ])
        })
        .collect();
    Paragraph::new(lines).render(text_area, buf);
    focused.then_some((
        text_area.x + 2 + cursor.0 as u16,
        text_area.y + (cursor.1 - scroll) as u16,
    ))
}

/// Rows the input box needs for `input` at `width` (text only, no border).
pub fn input_rows(input: &Input, width: u16) -> u16 {
    input
        .layout((width as usize).saturating_sub(6))
        .0
        .len()
        .clamp(1, 6) as u16
}

/// The Grove wordmark, as the TUI has always drawn it.
pub const LOGO: &[&str] = &[
    " ██████╗ ██████╗  ██████╗ ██╗   ██╗███████╗",
    "██╔════╝ ██╔══██╗██╔═══██╗██║   ██║██╔════╝",
    "██║  ███╗██████╔╝██║   ██║██║   ██║█████╗  ",
    "██║   ██║██╔══██╗██║   ██║╚██╗ ██╔╝██╔══╝  ",
    "╚██████╔╝██║  ██║╚██████╔╝ ╚████╔╝ ███████╗",
    " ╚═════╝ ╚═╝  ╚═╝ ╚═════╝   ╚═══╝  ╚══════╝",
];

/// A horizontal rule across a panel's inside, joined to its border.
fn rule(buf: &mut Buffer, area: Rect, y: u16, p: &Palette) {
    for x in area.x..area.x + area.width {
        if let Some(cell) = buf.cell_mut((x, y)) {
            cell.set_symbol("─").set_style(p.style(p.faint));
        }
    }
    for (x, symbol) in [(area.x.wrapping_sub(1), "├"), (area.x + area.width, "┤")] {
        if let Some(cell) = buf.cell_mut((x, y)) {
            cell.set_symbol(symbol).set_style(p.style(p.border));
        }
    }
}

/// A vertical divider between a panel's two columns, joined to the rules
/// above and below it.
fn divider(buf: &mut Buffer, x: u16, top: u16, bottom: u16, p: &Palette) {
    for y in top..bottom {
        if let Some(cell) = buf.cell_mut((x, y)) {
            cell.set_symbol("│").set_style(p.style(p.faint));
        }
    }
    for (y, symbol) in [(top.wrapping_sub(1), "┬"), (bottom, "┴")] {
        if let Some(cell) = buf.cell_mut((x, y)) {
            cell.set_symbol(symbol).set_style(p.style(p.faint));
        }
    }
}

// ── Agent / Model / Mode / Thinking ────────────────────────────────────────

pub const TABS: [&str; 4] = ["Agent", "Model", "Mode", "Thinking"];

pub struct AgentPanel {
    pub tab: usize,
    /// Choosing an agent for a new session in this task; the other tabs are
    /// about the open session, so they are hidden.
    pub new_in: Option<(String, String)>,
    pub agents: Vec<api::Agent>,
    pub cursor: [usize; 4],
    pub settings: Settings,
    pub current_agent: String,
    pub context: Option<(u64, u64)>,
    /// (project id, task id) of the open session.
    pub here: (String, String),
    /// "project › task" a new session goes into.
    pub place: String,
}

impl AgentPanel {
    fn choices(&self, tab: usize) -> Vec<Choice> {
        match tab {
            0 => self
                .agents
                .iter()
                .map(|agent| Choice {
                    id: agent.id.clone(),
                    name: agent.name.clone(),
                })
                .collect(),
            1 => self.settings.models.clone(),
            2 => self.settings.modes.clone(),
            _ => self.settings.thought_levels.clone(),
        }
    }

    fn current(&self, tab: usize) -> Option<String> {
        match tab {
            0 => Some(self.current_agent.clone()),
            1 => self.settings.current_model.clone(),
            2 => self.settings.current_mode.clone(),
            _ => self.settings.current_thought.clone(),
        }
    }

    /// Start each tab's cursor on its current value.
    pub fn with_cursors(mut self) -> Self {
        for tab in 0..TABS.len() {
            let current = self.current(tab);
            if let Some(index) = self
                .choices(tab)
                .iter()
                .position(|c| Some(&c.id) == current.as_ref())
            {
                self.cursor[tab] = index;
            }
        }
        self
    }

    fn tabs(&self) -> Vec<usize> {
        if self.new_in.is_some() {
            vec![0]
        } else {
            (0..TABS.len()).collect()
        }
    }

    pub fn key(&mut self, key: KeyEvent) -> Action {
        let choices = self.choices(self.tab);
        match key.code {
            KeyCode::Esc => return Action::Close,
            KeyCode::Tab | KeyCode::Right => {
                let tabs = self.tabs();
                let at = tabs.iter().position(|t| *t == self.tab).unwrap_or(0);
                self.tab = tabs[(at + 1) % tabs.len()];
            }
            KeyCode::BackTab | KeyCode::Left => {
                let tabs = self.tabs();
                let at = tabs.iter().position(|t| *t == self.tab).unwrap_or(0);
                self.tab = tabs[(at + tabs.len() - 1) % tabs.len()];
            }
            KeyCode::Up => self.cursor[self.tab] = self.cursor[self.tab].saturating_sub(1),
            KeyCode::Down => {
                if self.cursor[self.tab] + 1 < choices.len() {
                    self.cursor[self.tab] += 1;
                }
            }
            KeyCode::Enter => {
                let Some(choice) = choices.get(self.cursor[self.tab]) else {
                    return Action::Stay;
                };
                let id = choice.id.clone();
                return match self.tab {
                    0 => {
                        let (project_id, task_id) =
                            self.new_in.clone().unwrap_or_else(|| self.here.clone());
                        Action::New {
                            project_id,
                            task_id,
                            agent: Some(id),
                        }
                    }
                    1 => Action::Model(id),
                    2 => Action::Mode(id),
                    _ => Action::Thought(id),
                };
            }
            _ => {}
        }
        Action::Stay
    }

    pub fn draw(&self, buf: &mut Buffer, area: Rect, cx: &Context) {
        let p = cx.palette;
        let area = Rect::new(
            area.x + 2,
            area.y + 1,
            area.width.saturating_sub(4),
            area.height.saturating_sub(2),
        );
        let outer = Rect::new(area.x, area.y, area.width, area.height.saturating_sub(1));
        let block = panel(p, true);
        let inner = block.inner(outer);
        block.render(outer, buf);
        line_at(
            buf,
            area,
            area.y + area.height.saturating_sub(1),
            cx.status.clone(),
        );

        // Tabs.
        let head = Rect::new(inner.x + 1, inner.y, inner.width.saturating_sub(2), 1);
        let mut spans = Vec::new();
        if self.new_in.is_some() {
            spans.push(Span::styled(
                "New session — choose an agent",
                p.style(p.text).add_modifier(Modifier::BOLD),
            ));
        } else {
            for tab in self.tabs() {
                let name = TABS[tab];
                spans.push(if tab == self.tab {
                    Span::styled(
                        name,
                        p.style(p.agent)
                            .add_modifier(Modifier::BOLD | Modifier::UNDERLINED),
                    )
                } else {
                    Span::styled(name, p.style(p.muted))
                });
                spans.push(Span::raw("    "));
            }
        }
        line_at(buf, head, head.y, Line::from(spans));
        let hint = if self.new_in.is_some() {
            "the agent stays with the session"
        } else {
            "tab switches group"
        };
        line_at(
            buf,
            Rect::new(
                head.x + head.width.saturating_sub(width(hint) as u16),
                head.y,
                width(hint) as u16,
                1,
            ),
            head.y,
            Line::from(Span::styled(hint, p.style(p.muted))),
        );
        rule(buf, inner, inner.y + 1, p);
        let footer_y = inner.y + inner.height.saturating_sub(1);
        rule(buf, inner, footer_y.saturating_sub(1), p);
        line_at(
            buf,
            Rect::new(inner.x + 1, footer_y, inner.width.saturating_sub(2), 1),
            footer_y,
            keys(
                p,
                &[
                    ("↑↓", "select"),
                    ("⏎", "apply"),
                    ("tab", "next group"),
                    ("esc", "close"),
                ],
            ),
        );

        let body = Rect::new(
            inner.x,
            inner.y + 2,
            inner.width,
            inner.height.saturating_sub(4),
        );
        let left_w = (body.width / 2).clamp(30, 56).min(body.width);
        let left = Rect::new(
            body.x + 1,
            body.y + 1,
            left_w.saturating_sub(2),
            body.height.saturating_sub(1),
        );
        divider(buf, body.x + left_w, body.y, body.y + body.height, p);
        let choices = self.choices(self.tab);
        let current = self.current(self.tab);
        if choices.is_empty() {
            line_at(
                buf,
                left,
                left.y,
                Line::from(Span::styled(
                    format!(
                        "This agent offers no {} choices",
                        TABS[self.tab].to_lowercase()
                    ),
                    p.style(p.muted),
                )),
            );
        }
        let visible = left.height as usize;
        let start = self.cursor[self.tab].saturating_sub(visible.saturating_sub(1));
        for (index, choice) in choices.iter().enumerate().skip(start).take(visible) {
            let selected = index == self.cursor[self.tab];
            let is_current = Some(&choice.id) == current.as_ref();
            let name = if choice.name.is_empty() {
                &choice.id
            } else {
                &choice.name
            };
            let mut line = Line::from(vec![
                Span::styled(
                    if selected { "❯ " } else { "  " },
                    p.style(p.agent).add_modifier(Modifier::BOLD),
                ),
                Span::styled(
                    pad(name, (left.width as usize).saturating_sub(12)),
                    if selected {
                        p.style(p.text).add_modifier(Modifier::BOLD)
                    } else {
                        p.style(p.text)
                    },
                ),
                Span::styled(if is_current { "current" } else { "" }, p.style(p.muted)),
            ]);
            if selected {
                line.style = Style::default().bg(p.panel);
            }
            line_at(buf, left, left.y + (index - start) as u16, line);
        }

        // Right: the open session's settings, or where a new one goes.
        let right = Rect::new(
            body.x + left_w + 3,
            body.y + 1,
            body.width.saturating_sub(left_w + 5),
            body.height.saturating_sub(1),
        );
        if self.new_in.is_some() {
            line_at(buf, right, right.y, label(p, "New session in"));
            line_at(
                buf,
                right,
                right.y + 2,
                Line::from(Span::styled(
                    self.place.clone(),
                    p.style(p.text).add_modifier(Modifier::BOLD),
                )),
            );
            line_at(
                buf,
                right,
                right.y + 4,
                Line::from(Span::styled(
                    "The agent works in this task's directory.",
                    p.style(p.muted),
                )),
            );
            line_at(
                buf,
                right,
                right.y + 5,
                Line::from(Span::styled(
                    "A session keeps its agent; start another to switch.",
                    p.style(p.muted),
                )),
            );
            return;
        }
        line_at(buf, right, right.y, label(p, "Current session"));
        let settings = &self.settings;
        let rows: Vec<(&str, String)> = vec![
            ("Agent", cx.agent(&self.current_agent)),
            ("Model", settings.model_name().unwrap_or_else(|| "—".into())),
            ("Mode", settings.mode_name().unwrap_or_else(|| "—".into())),
            (
                "Thinking",
                settings.thought_name().unwrap_or_else(|| "—".into()),
            ),
            (
                "Context",
                match self.context.filter(|(_, size)| *size > 0) {
                    Some((used, size)) => format!(
                        "{}% · {} / {}",
                        used * 100 / size,
                        super::render::compact_number(used),
                        super::render::compact_number(size)
                    ),
                    None => "—".into(),
                },
            ),
        ];
        for (index, (key, value)) in rows.into_iter().enumerate() {
            line_at(
                buf,
                right,
                right.y + 2 + index as u16,
                Line::from(vec![
                    Span::styled(pad(key, 12), p.style(p.muted)),
                    Span::styled(
                        value,
                        if key == "Mode" {
                            p.style(p.warn)
                        } else {
                            p.style(p.text)
                        },
                    ),
                ]),
            );
        }
        if self.tab == 0 {
            let note_y = right.y + 9;
            if note_y + 4 <= right.y + right.height {
                let note = Rect::new(right.x, note_y, right.width, 4);
                let block = Block::default()
                    .borders(Borders::ALL)
                    .border_type(BorderType::Rounded)
                    .border_style(p.style(p.warn));
                let inside = block.inner(note);
                block.render(note, buf);
                let inside = Rect::new(inside.x + 1, inside.y, inside.width.saturating_sub(2), 2);
                line_at(
                    buf,
                    inside,
                    inside.y,
                    Line::from(Span::styled(
                        "Picking an agent starts a new session.",
                        p.style(p.warn),
                    )),
                );
                line_at(
                    buf,
                    inside,
                    inside.y + 1,
                    Line::from(Span::styled("This one keeps its agent.", p.style(p.muted))),
                );
            }
        }
    }
}

// ── Projects page ──────────────────────────────────────────────────────────

const CARD_HEIGHT: u16 = 5;
const MIN_CARD_WIDTH: u16 = 32;
const MAX_CARD_WIDTH: u16 = 56;
const GAP_X: u16 = 2;
const GAP_Y: u16 = 1;
const BLOCK_WIDTH: usize = 6;

/// A card on the projects page.
#[derive(Clone, Copy, PartialEq)]
pub enum Card {
    Project(usize),
    /// The Buddies, as one special project: its "sessions" are the Buddies.
    Buddies,
}

/// The projects page, drawn as the TUI's workspace always was: the
/// wordmark, then project cards with a colored block — and the Buddies
/// beside the projects, as their own way in.
pub struct ProjectsPage {
    pub projects: Vec<api::Project>,
    pub buddies: Vec<api::Buddy>,
    pub selected: usize,
    /// Where the cards were drawn last, for arrows and clicks.
    pub layout: std::cell::RefCell<Vec<(Card, Rect)>>,
    /// The open project, if any (esc returns to it).
    pub current: Option<String>,
}

/// `ProjectsPage::current` while the Buddies are open.
pub const BUDDIES: &str = "buddies";

pub enum PageAction {
    Stay,
    Close,
    Quit,
    OpenProject(String),
    OpenBuddies,
    Theme,
    AddProject,
}

fn lerp(a: ratatui::style::Color, b: ratatui::style::Color, t: f32) -> ratatui::style::Color {
    use ratatui::style::Color;
    match (a, b) {
        (Color::Rgb(r1, g1, b1), Color::Rgb(r2, g2, b2)) => {
            let l = |a: u8, b: u8| (a as f32 + (b as f32 - a as f32) * t.clamp(0.0, 1.0)) as u8;
            Color::Rgb(l(r1, r2), l(g1, g2), l(b1, b2))
        }
        _ => a,
    }
}

/// One row of a card's colored block (diagonal gradient across its 3 rows).
fn block_row(row: usize, p: &Palette, index: usize) -> Vec<Span<'static>> {
    block_row_n(row, p, index, BLOCK_WIDTH)
}

/// [`block_row`] for a block `cols` wide.
pub fn block_row_n(row: usize, p: &Palette, index: usize, cols: usize) -> Vec<Span<'static>> {
    let len = p.accent_palette.len();
    let (a, b) = (
        p.accent_palette[index % len],
        p.accent_palette[(index + 1) % len],
    );
    let max_t = (cols - 1 + 2) as f32;
    (0..cols)
        .map(|col| {
            let t = (col as f32 + (2 - row) as f32) / max_t;
            Span::styled(" ", Style::default().bg(lerp(a, b, t)))
        })
        .collect()
}

/// `~/a/b/c/name` → `~/a/b/c/name` or `~/a/…/name` to fit.
fn short_path(path: &str, max: usize) -> String {
    let path = match std::env::var("HOME") {
        Ok(home) if path.starts_with(&home) => format!("~{}", &path[home.len()..]),
        _ => path.to_string(),
    };
    if width(&path) <= max {
        return path;
    }
    let parts: Vec<&str> = path.split('/').collect();
    if parts.len() > 2 {
        let middle: Vec<String> = parts[1..parts.len() - 1]
            .iter()
            .map(|s| s.chars().next().unwrap_or('?').to_string())
            .collect();
        let compact = format!(
            "{}/{}/{}",
            parts[0],
            middle.join("/"),
            parts[parts.len() - 1]
        );
        if width(&compact) <= max {
            return compact;
        }
    }
    fit(&path, max)
}

impl ProjectsPage {
    fn cards(&self) -> Vec<Card> {
        std::iter::once(Card::Buddies)
            .chain((0..self.projects.len()).map(Card::Project))
            .collect()
    }

    /// The card at a screen position.
    pub fn hit(&self, x: u16, y: u16) -> Option<usize> {
        let layout = self.layout.borrow();
        let cards = self.cards();
        layout
            .iter()
            .find(|(_, r)| x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height)
            .and_then(|(card, _)| cards.iter().position(|c| c == card))
    }

    /// What opening card `index` does.
    pub fn activate(&self, index: usize) -> PageAction {
        match self.cards().get(index) {
            Some(Card::Project(i)) => PageAction::OpenProject(self.projects[*i].id.clone()),
            Some(Card::Buddies) => PageAction::OpenBuddies,
            None => PageAction::Stay,
        }
    }

    /// Move to the nearest card in a direction, by where cards were drawn.
    fn step(&mut self, dx: i32, dy: i32) {
        let layout = self.layout.borrow();
        let cards = self.cards();
        let Some(current) = cards
            .get(self.selected)
            .and_then(|c| layout.iter().find(|(card, _)| card == c))
            .map(|(_, r)| *r)
        else {
            return;
        };
        let best = layout
            .iter()
            .filter(|(_, r)| {
                if dy > 0 {
                    r.y > current.y
                } else if dy < 0 {
                    r.y < current.y
                } else if dx > 0 {
                    r.y == current.y && r.x > current.x
                } else {
                    r.y == current.y && r.x < current.x
                }
            })
            .min_by_key(|(_, r)| {
                let ry = (r.y as i32 - current.y as i32).abs();
                let rx = (r.x as i32 - current.x as i32).abs();
                if dy != 0 {
                    ry * 1000 + rx
                } else {
                    rx
                }
            })
            .map(|(card, _)| *card);
        drop(layout);
        if let Some(card) = best {
            if let Some(index) = cards.iter().position(|c| *c == card) {
                self.selected = index;
            }
        }
    }

    pub fn key(&mut self, key: KeyEvent) -> PageAction {
        match key.code {
            KeyCode::Left | KeyCode::Char('h') => self.step(-1, 0),
            KeyCode::Right | KeyCode::Char('l') => self.step(1, 0),
            KeyCode::Up | KeyCode::Char('k') => self.step(0, -1),
            KeyCode::Down | KeyCode::Char('j') => self.step(0, 1),
            KeyCode::Enter => return self.activate(self.selected),
            KeyCode::Char('a') => return PageAction::AddProject,
            KeyCode::Char('t') => return PageAction::Theme,
            KeyCode::Char('q') => return PageAction::Quit,
            KeyCode::Esc if self.current.is_some() => return PageAction::Close,
            _ => {}
        }
        PageAction::Stay
    }

    pub fn draw(&self, buf: &mut Buffer, area: Rect, p: &Palette, server: &str) {
        let centered = |buf: &mut Buffer, y: u16, line: Line<'static>| {
            if y < area.y + area.height {
                Paragraph::new(line)
                    .alignment(ratatui::layout::Alignment::Center)
                    .render(Rect::new(area.x, y, area.width, 1), buf);
            }
        };
        // Footer: key hints in a bordered bar, as the TUI's.
        let footer = Rect::new(
            area.x,
            area.y + area.height.saturating_sub(3),
            area.width,
            3,
        );
        let mut keys = vec![
            ("Enter", "open"),
            ("←↑↓→", "move"),
            ("a", "add this directory"),
            ("t", "theme"),
        ];
        if self.current.is_some() {
            keys.push(("Esc", "back"));
        }
        keys.push(("q", "quit"));
        let mut spans = vec![Span::raw(" ")];
        for (index, (key, what)) in keys.iter().enumerate() {
            if index > 0 {
                spans.push(Span::raw("   "));
            }
            spans.push(Span::styled(
                key.to_string(),
                p.style(p.highlight).add_modifier(Modifier::BOLD),
            ));
            spans.push(Span::styled(format!(" {what}"), p.style(p.muted)));
        }
        Paragraph::new(Line::from(spans))
            .block(
                Block::default()
                    .borders(Borders::ALL)
                    .border_style(p.style(p.border)),
            )
            .render(footer, buf);

        // Wordmark and subtitle.
        let mut y = area.y + 1;
        for row in LOGO {
            centered(
                buf,
                y,
                Line::from(Span::styled(row.to_string(), p.style(p.logo))),
            );
            y += 1;
        }
        y += 1;
        centered(
            buf,
            y,
            Line::from(Span::styled(
                format!("v{} · {server}", env!("CARGO_PKG_VERSION")),
                p.style(p.muted),
            )),
        );
        y += 2;

        // Card grid, scrolled so the selected card shows.
        let body_top = y;
        let body_bottom = footer.y.saturating_sub(1);
        let usable = area.width.saturating_sub(4);
        let cols = [3u16, 2, 1]
            .into_iter()
            .find(|cols| usable >= cols * MIN_CARD_WIDTH + (cols - 1) * GAP_X)
            .unwrap_or(1);
        let card_w = ((usable.saturating_sub((cols - 1) * GAP_X)) / cols).min(MAX_CARD_WIDTH);
        let grid_w = cols * card_w + (cols - 1) * GAP_X;
        let left = area.x + area.width.saturating_sub(grid_w) / 2;

        // Lay out in virtual rows first: (title, cards).
        let mut placed: Vec<(Option<&'static str>, Option<Card>, u16, u16)> = Vec::new();
        let mut vy: u16 = 0;
        let mut section = |title: &'static str, cards: Vec<Card>, vy: &mut u16| {
            if cards.is_empty() {
                return;
            }
            placed.push((Some(title), None, 0, *vy));
            *vy += 2;
            for (index, card) in cards.into_iter().enumerate() {
                let col = (index as u16) % cols;
                let row = (index as u16) / cols;
                placed.push((
                    None,
                    Some(card),
                    left + col * (card_w + GAP_X),
                    *vy + row * (CARD_HEIGHT + GAP_Y),
                ));
            }
            let rows = placed.iter().filter(|(_, c, _, _)| c.is_some()).count() as u16;
            let _ = rows;
            let last = placed.last().map(|(_, _, _, y)| *y).unwrap_or(*vy);
            *vy = last + CARD_HEIGHT + GAP_Y + 1;
        };
        section("Your Projects", self.cards(), &mut vy);
        let cards = self.cards();
        let selected_y = cards
            .get(self.selected)
            .and_then(|c| {
                placed
                    .iter()
                    .find(|(_, card, _, _)| card.as_ref() == Some(c))
            })
            .map(|(_, _, _, y)| *y)
            .unwrap_or(0);
        let room = body_bottom.saturating_sub(body_top);
        let offset = (selected_y + CARD_HEIGHT).saturating_sub(room);

        let mut layout = Vec::new();
        for (title, card, x, vy) in placed {
            let Some(y) = vy.checked_sub(offset).map(|v| body_top + v) else {
                continue;
            };
            if let Some(title) = title {
                if y < body_bottom {
                    centered(
                        buf,
                        y,
                        Line::from(Span::styled(format!("─── {title} ───"), p.style(p.muted))),
                    );
                }
                continue;
            }
            let Some(card) = card else { continue };
            if y + CARD_HEIGHT > body_bottom {
                continue;
            }
            let rect = Rect::new(x, y, card_w, CARD_HEIGHT);
            let selected = cards.get(self.selected) == Some(&card);
            self.draw_card(buf, rect, card, selected, p);
            layout.push((card, rect));
        }
        if self.projects.is_empty() && self.buddies.is_empty() {
            centered(
                buf,
                body_top + 1,
                Line::from(Span::styled(
                    "No projects yet — press a to add this directory",
                    p.style(p.muted),
                )),
            );
        }
        *self.layout.borrow_mut() = layout;
    }

    fn draw_card(&self, buf: &mut Buffer, area: Rect, card: Card, selected: bool, p: &Palette) {
        let bg = if selected { p.panel } else { p.bg };
        buf.set_style(area, Style::default().bg(bg));
        let content_w = (area.width as usize).saturating_sub(10);
        let (index, name, line2, line3, mark): (
            usize,
            String,
            String,
            Span<'static>,
            Span<'static>,
        ) = match card {
            Card::Project(i) => {
                let project = &self.projects[i];
                let current = self.current.as_deref() == Some(project.id.as_str());
                let kind = if project.project_type == "studio" {
                    "studio · "
                } else {
                    ""
                };
                let tasks = format!(
                    "{kind}{} task{}",
                    project.task_count,
                    if project.task_count == 1 { "" } else { "s" }
                );
                (
                    i,
                    project.name.clone(),
                    short_path(&project.path, content_w),
                    if project.live_count > 0 {
                        Span::styled(
                            format!("{tasks} · {} live", project.live_count),
                            p.style(p.muted),
                        )
                    } else {
                        Span::styled(tasks, p.style(p.muted))
                    },
                    if current {
                        Span::styled("●", p.style(p.accent))
                    } else {
                        Span::raw(" ")
                    },
                )
            }
            Card::Buddies => {
                let count = self.buddies.len();
                let waiting: u32 = self.buddies.iter().map(|b| b.waiting_delegations).sum();
                let state = if waiting > 0 {
                    Span::styled(format!("{waiting} waiting"), p.style(p.warn))
                } else if count == 0 {
                    Span::styled("create one in the GUI", p.style(p.muted))
                } else {
                    Span::styled("idle", p.style(p.muted))
                };
                let here = self.current.as_deref() == Some(BUDDIES);
                (
                    7,
                    "Buddies".to_string(),
                    format!("{count} {}", if count == 1 { "buddy" } else { "buddies" }),
                    state,
                    if here {
                        Span::styled("●", p.style(p.accent))
                    } else {
                        Span::styled("◈", p.style(p.agent))
                    },
                )
            }
        };
        let name_style = if selected {
            p.style(p.highlight).add_modifier(Modifier::BOLD)
        } else {
            p.style(p.text).add_modifier(Modifier::BOLD)
        };
        let rows: [Vec<Span<'static>>; 3] = [
            vec![
                Span::styled(pad(&name, content_w.saturating_sub(2)), name_style),
                Span::raw(" "),
                mark,
            ],
            vec![Span::styled(fit(&line2, content_w), p.style(p.muted))],
            vec![line3],
        ];
        for (row, content) in rows.into_iter().enumerate() {
            let mut spans = vec![Span::raw(" ")];
            spans.extend(block_row(row, p, index));
            spans.push(Span::raw("  "));
            spans.extend(content);
            Paragraph::new(Line::from(spans))
                .style(Style::default().bg(bg))
                .render(
                    Rect::new(area.x, area.y + 1 + row as u16, area.width, 1),
                    buf,
                );
        }
    }
}

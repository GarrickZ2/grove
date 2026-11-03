//! `grove` with no subcommand: a few lines right in the terminal to choose
//! how to open Grove — the last way, or Web, App, CLI (each on this machine
//! or another one), or Remote (let other machines in).

use std::io;
use std::time::Duration;

use crossterm::event::{self, Event, KeyCode, KeyEventKind, KeyModifiers};
use ratatui::backend::CrosstermBackend;
use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use ratatui::style::Modifier;
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, BorderType, Borders, Paragraph, Widget};
use ratatui::{Terminal, TerminalOptions, Viewport};
use unicode_width::UnicodeWidthStr;

use super::chat::render::Palette;
use super::{web, Commands};
use crate::storage::config::LastLaunch;

/// A way to open Grove.
#[derive(Clone, Copy, PartialEq)]
enum Kind {
    Recent,
    Web,
    App,
    Cli,
    Remote,
}

impl Kind {
    /// Web, App and CLI can open this machine's Grove or another one's.
    fn has_target(self) -> bool {
        matches!(self, Kind::Web | Kind::App | Kind::Cli)
    }
}

struct Choice {
    kind: Kind,
    title: String,
    /// A word or two under the title on its card.
    short: String,
    about: String,
}

/// What a person calls each way of opening Grove.
fn name(launch: &LastLaunch) -> &'static str {
    match launch {
        LastLaunch::Tui => "CLI",
        LastLaunch::Web { .. } => "Web",
        LastLaunch::Gui { .. } => "App",
        LastLaunch::Mobile { .. } => "Remote",
    }
}

fn choices(last: Option<&LastLaunch>) -> Vec<Choice> {
    let mut list = Vec::new();
    if let Some(last) = last {
        list.push(Choice {
            kind: Kind::Recent,
            title: "Recent".into(),
            short: name(last).into(),
            about: format!("grove {}", last.display_label()),
        });
    }
    let mut add = |kind, title: &str, short: &str, about: String| {
        list.push(Choice {
            kind,
            title: title.into(),
            short: short.into(),
            about,
        })
    };
    add(
        Kind::Web,
        "Web",
        "browser",
        format!(
            "The full IDE in your browser at localhost:{}",
            web::DEFAULT_PORT
        ),
    );
    if cfg!(feature = "gui") {
        add(Kind::App, "App", "desktop", "The desktop window".into());
    }
    add(
        Kind::Cli,
        "CLI",
        "terminal",
        "Projects, tasks and sessions right in this terminal".into(),
    );
    add(
        Kind::Remote,
        "Remote",
        "phone & more",
        "Let your phone and other machines connect here".into(),
    );
    list
}

/// The command for a choice; `remote` is another machine's Grove.
fn command(kind: Kind, last: Option<&LastLaunch>, remote: Option<String>) -> Option<Commands> {
    Some(match kind {
        Kind::Recent => last?.to_command(),
        Kind::Web => Commands::Web {
            port: web::DEFAULT_PORT,
            no_open: false,
            dev: false,
            remote_url: remote,
        },
        Kind::App => Commands::Gui {
            port: 3001,
            remote_url: remote,
        },
        Kind::Cli => Commands::Tui { remote },
        Kind::Remote => Commands::Mobile {
            port: web::DEFAULT_PORT,
            no_open: false,
            tls: false,
            cert: None,
            key: None,
            host: None,
            public: false,
            private: false,
        },
    })
}

/// Where the panel is.
enum Stage {
    /// Choosing how to open Grove.
    Main,
    /// This machine or another one, for a choice.
    Target(usize),
    /// Typing the other machine's address.
    Address(usize, String),
}

/// Rows the panel takes in the terminal: heading, cards, note, keys.
const HEIGHT: u16 = 7;

fn keys(p: &Palette, pairs: &[(&str, &str)]) -> Line<'static> {
    let mut spans = vec![Span::raw("  ")];
    for (index, (key, what)) in pairs.iter().enumerate() {
        if index > 0 {
            spans.push(Span::raw("   "));
        }
        spans.push(Span::styled(
            key.to_string(),
            p.style(p.highlight).add_modifier(Modifier::BOLD),
        ));
        spans.push(Span::styled(format!(" {what}"), p.style(p.faint)));
    }
    Line::from(spans)
}

struct Panel {
    list: Vec<Choice>,
    selected: usize,
    stage: Stage,
    /// This machine (0) or another one (1) on the target step.
    target: usize,
    /// Address to suggest for "another machine".
    suggested: String,
    /// Why the address was refused.
    error: Option<String>,
}

/// What a key leads to.
enum Step {
    Stay,
    Quit,
    Open(Kind, Option<String>),
}

const TARGETS: [(&str, &str, &str); 2] = [
    (
        "This machine",
        "local",
        "start or reuse the Grove running here",
    ),
    (
        "Another machine",
        "remote",
        "connect to a Grove started there with `grove remote`",
    ),
];

impl Panel {
    fn count(&self) -> usize {
        match self.stage {
            Stage::Main => self.list.len(),
            _ => TARGETS.len(),
        }
    }

    /// Heading, a row of cards, the selected card's note and the keys.
    fn draw(&self, buf: &mut Buffer, area: Rect, p: &Palette) {
        let heading = match &self.stage {
            Stage::Main => "how would you like to open Grove?".to_string(),
            Stage::Target(i) | Stage::Address(i, _) => {
                format!("open {} on which Grove?", self.list[*i].title)
            }
        };
        let line = |buf: &mut Buffer, y: u16, line: Line<'static>| {
            Paragraph::new(line).render(Rect::new(area.x, area.y + y, area.width, 1), buf);
        };
        line(
            buf,
            0,
            Line::from(vec![
                Span::styled("◆ ", p.style(p.accent)),
                Span::styled("grove", p.style(p.text).add_modifier(Modifier::BOLD)),
                Span::styled(
                    format!(" v{} · {heading}", env!("CARGO_PKG_VERSION")),
                    p.style(p.muted),
                ),
            ]),
        );
        let card = |buf: &mut Buffer, rect: Rect, title: &str, short: Line<'static>, on: bool| {
            let block = Block::default()
                .borders(Borders::ALL)
                .border_type(BorderType::Rounded)
                .border_style(if on {
                    p.style(p.highlight).add_modifier(Modifier::BOLD)
                } else {
                    p.style(p.border)
                });
            let inside = block.inner(rect);
            block.render(rect, buf);
            Paragraph::new(vec![
                Line::from(Span::styled(
                    title.to_string(),
                    if on {
                        p.style(p.highlight).add_modifier(Modifier::BOLD)
                    } else {
                        p.style(p.text).add_modifier(Modifier::BOLD)
                    },
                )),
                short,
            ])
            .render(
                Rect::new(inside.x + 1, inside.y, inside.width.saturating_sub(1), 2),
                buf,
            );
        };

        if let Stage::Address(_, address) = &self.stage {
            let rect = Rect::new(area.x, area.y + 1, 64.min(area.width), 4);
            card(
                buf,
                rect,
                "Address",
                Line::from(vec![
                    Span::styled(address.clone(), p.style(p.text)),
                    Span::styled("▏", p.style(p.highlight)),
                ]),
                true,
            );
            let (note, style) = match &self.error {
                Some(error) => (error.clone(), p.style(p.error)),
                None => (
                    "it asks for that Grove's passkey the first time".to_string(),
                    p.style(p.muted),
                ),
            };
            line(buf, 5, Line::from(Span::styled(format!("  {note}"), style)));
            line(buf, 6, keys(p, &[("⏎", "connect"), ("esc", "back")]));
            return;
        }

        let cards: Vec<(&str, &str)> = match self.stage {
            Stage::Main => self
                .list
                .iter()
                .map(|c| (c.title.as_str(), c.short.as_str()))
                .collect(),
            _ => TARGETS
                .iter()
                .map(|(title, short, _)| (*title, *short))
                .collect(),
        };
        let selected = match self.stage {
            Stage::Main => self.selected,
            _ => self.target,
        };
        let mut x = area.x;
        for (index, (title, short)) in cards.iter().enumerate() {
            let width = (title.width().max(short.width()) as u16 + 4).max(12);
            if x + width > area.x + area.width {
                break;
            }
            card(
                buf,
                Rect::new(x, area.y + 1, width, 4),
                title,
                Line::from(Span::styled(short.to_string(), p.style(p.muted))),
                index == selected,
            );
            x += width + 1;
        }
        let note = match self.stage {
            Stage::Main => self.list[selected].about.clone(),
            _ => TARGETS[selected].2.to_string(),
        };
        line(
            buf,
            5,
            Line::from(Span::styled(format!("  {note}"), p.style(p.muted))),
        );
        let hints = match self.stage {
            Stage::Main => keys(p, &[("←→", "choose"), ("⏎", "open"), ("q", "quit")]),
            _ => keys(p, &[("←→", "choose"), ("⏎", "open"), ("esc", "back")]),
        };
        line(buf, 6, hints);
    }

    /// Pick a row of the current stage.
    fn pick(&mut self, index: usize) -> Step {
        match &self.stage {
            Stage::Main => {
                self.selected = index;
                let kind = self.list[index].kind;
                if kind.has_target() {
                    self.stage = Stage::Target(index);
                    self.target = 0;
                    Step::Stay
                } else {
                    Step::Open(kind, None)
                }
            }
            Stage::Target(i) | Stage::Address(i, _) => {
                let i = *i;
                self.target = index;
                if index == 0 {
                    return Step::Open(self.list[i].kind, None);
                }
                self.stage = Stage::Address(i, self.suggested.clone());
                Step::Stay
            }
        }
    }

    fn connect(&mut self, i: usize, address: String) -> Step {
        let address = address.trim().trim_end_matches('/').to_string();
        if address.is_empty() {
            self.error = Some("type the address, e.g. http://devbox.lan:3001".into());
            return Step::Stay;
        }
        let address = if address.contains("://") {
            address
        } else {
            format!("http://{address}")
        };
        Step::Open(self.list[i].kind, Some(address))
    }

    fn key(&mut self, code: KeyCode, ctrl: bool) -> Step {
        if ctrl && code == KeyCode::Char('c') {
            return Step::Quit;
        }
        if let Stage::Address(i, address) = &mut self.stage {
            let i = *i;
            match code {
                KeyCode::Enter => {
                    let address = address.clone();
                    return self.connect(i, address);
                }
                KeyCode::Esc => self.stage = Stage::Target(i),
                KeyCode::Backspace => {
                    address.pop();
                }
                KeyCode::Char('u') if ctrl => address.clear(),
                KeyCode::Char(ch) if !ctrl => address.push(ch),
                _ => {}
            }
            self.error = None;
            return Step::Stay;
        }
        let count = self.count();
        let main = matches!(self.stage, Stage::Main);
        let row = if main {
            &mut self.selected
        } else {
            &mut self.target
        };
        match code {
            KeyCode::Left | KeyCode::Up | KeyCode::Char('h') | KeyCode::Char('k') => {
                *row = (*row + count - 1) % count
            }
            KeyCode::Right
            | KeyCode::Down
            | KeyCode::Char('l')
            | KeyCode::Char('j')
            | KeyCode::Tab => *row = (*row + 1) % count,
            KeyCode::Enter => {
                let index = *row;
                return self.pick(index);
            }
            KeyCode::Char(ch @ '1'..='9') => {
                let index = ch as usize - '1' as usize;
                if index < count {
                    return self.pick(index);
                }
            }
            KeyCode::Esc | KeyCode::Char('q') if main => return Step::Quit,
            KeyCode::Esc | KeyCode::Char('q') => self.stage = Stage::Main,
            _ => {}
        }
        Step::Stay
    }
}

/// Ask how to open Grove, right in the terminal. `None` when the person
/// leaves without choosing. The bool is true when the choice replays the
/// last way (nothing new to remember).
pub fn choose(last: Option<&LastLaunch>) -> Option<(Commands, bool)> {
    let palette = Palette::load();
    let mut panel = Panel {
        list: choices(last),
        selected: 0,
        stage: Stage::Main,
        target: 0,
        suggested: super::chat::last_remote().unwrap_or_default(),
        error: None,
    };
    crossterm::terminal::enable_raw_mode().ok()?;
    let Ok(mut term) = Terminal::with_options(
        CrosstermBackend::new(io::stdout()),
        TerminalOptions {
            viewport: Viewport::Inline(HEIGHT),
        },
    ) else {
        let _ = crossterm::terminal::disable_raw_mode();
        return None;
    };
    let step = loop {
        let _ = term.draw(|frame| {
            let area = frame.area();
            panel.draw(frame.buffer_mut(), area, &palette);
        });
        if !event::poll(Duration::from_millis(250)).unwrap_or(false) {
            continue;
        }
        let step = match event::read() {
            Ok(Event::Key(key)) if key.kind != KeyEventKind::Release => {
                panel.key(key.code, key.modifiers.contains(KeyModifiers::CONTROL))
            }
            Ok(Event::Paste(text)) => {
                if let Stage::Address(_, address) = &mut panel.stage {
                    address.push_str(text.trim());
                }
                Step::Stay
            }
            _ => Step::Stay,
        };
        if !matches!(step, Step::Stay) {
            break step;
        }
    };
    // Leave one line behind saying what happened, then hand over.
    let _ = term.clear();
    let _ = crossterm::terminal::disable_raw_mode();
    match step {
        Step::Open(kind, remote) => {
            let command = command(kind, last, remote)?;
            Some((command, kind == Kind::Recent))
        }
        _ => None,
    }
}

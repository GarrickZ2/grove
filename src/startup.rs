//! Startup progress, so a slow start never looks like a dead one.
//!
//! Every surface reports the step it is on through [`step`]. In a terminal
//! that is one line per step; in the GUI's background process the lines go to
//! `gui.log`, where the `grove gui` command that launched it reads them back
//! ([`parse_line`]) and the launch window asks for the current one ([`status`]).

// Only the GUI reads the status back.
#![cfg_attr(not(feature = "gui"), allow(dead_code))]

use std::io::IsTerminal;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use serde::Serialize;

const STEP_PREFIX: &str = "[startup] step: ";
const READY_LINE: &str = "[startup] ready";
const FAILED_PREFIX: &str = "[startup] failed: ";

/// What the launch window shows while the backend is getting ready.
#[derive(Debug, Clone, Default, Serialize)]
pub struct Status {
    /// The step in progress, empty before the first one.
    pub step: String,
    pub ready: bool,
    pub error: Option<String>,
    /// Nothing was set up on this machine before this start.
    pub first_run: bool,
}

static STATUS: Mutex<Status> = Mutex::new(Status {
    step: String::new(),
    ready: false,
    error: None,
    first_run: false,
});
static HEADER_PRINTED: AtomicBool = AtomicBool::new(false);

fn update(change: impl FnOnce(&mut Status)) {
    if let Ok(mut status) = STATUS.lock() {
        change(&mut status);
    }
}

pub fn status() -> Status {
    STATUS.lock().map(|s| s.clone()).unwrap_or_default()
}

/// Print a step the way a terminal shows it, under a one-time heading.
pub fn print_step(label: &str) {
    if !HEADER_PRINTED.swap(true, Ordering::SeqCst) {
        eprintln!("Starting Grove");
    }
    eprintln!("  • {label}…");
}

/// A step has started. Call it before anything that can take a noticeable time.
pub fn step(label: &str) {
    update(|s| s.step = label.to_string());
    if std::io::stderr().is_terminal() {
        print_step(label);
    } else {
        eprintln!("{STEP_PREFIX}{label}");
    }
}

/// This start is setting Grove up for the first time on this machine.
pub fn mark_first_run() {
    update(|s| s.first_run = true);
}

/// The backend is serving. Each surface prints its own "open" line after this.
pub fn ready() {
    update(|s| {
        s.ready = true;
        s.step.clear();
    });
    if !std::io::stderr().is_terminal() {
        eprintln!("{READY_LINE}");
    }
}

/// Startup cannot continue.
pub fn fail(message: &str) {
    update(|s| s.error = Some(message.to_string()));
    if std::io::stderr().is_terminal() {
        eprintln!("  ✗ {message}");
    } else {
        eprintln!("{FAILED_PREFIX}{message}");
    }
}

/// A progress line read back from the GUI's log.
#[derive(Debug, PartialEq, Eq)]
pub enum Event {
    Step(String),
    Ready,
    Failed(String),
}

pub fn parse_line(line: &str) -> Option<Event> {
    let line = line.trim_end();
    if line == READY_LINE {
        Some(Event::Ready)
    } else if let Some(label) = line.strip_prefix(STEP_PREFIX) {
        Some(Event::Step(label.to_string()))
    } else {
        line.strip_prefix(FAILED_PREFIX)
            .map(|message| Event::Failed(message.to_string()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn log_lines_are_read_back_as_events() {
        assert_eq!(
            parse_line("[startup] step: Getting the agent list\n"),
            Some(Event::Step("Getting the agent list".to_string()))
        );
        assert_eq!(parse_line("[startup] ready"), Some(Event::Ready));
        assert_eq!(
            parse_line("[startup] failed: no network"),
            Some(Event::Failed("no network".to_string()))
        );
        assert_eq!(parse_line("[ACP] Releasing idle runtime"), None);
    }
}

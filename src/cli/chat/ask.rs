//! Answering an agent's [`Form`] in the terminal: one question at a time,
//! choices picked with arrows or digits, text typed into the normal input box.

use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};

use super::form::{Answer, Form, Kind, Question, Source};
use super::render::{self, Palette};

const OPTION_ROWS: usize = 7;

/// The user's progress through the first open form.
pub struct Draft {
    pub id: String,
    pub step: usize,
    pub answers: Vec<Option<Answer>>,
    /// Highlighted row of a choice, rating or yes/no question.
    pub cursor: usize,
    /// Toggled rows of a multi-choice question.
    pub picked: Vec<bool>,
    pub error: Option<String>,
    /// An elicitation answer is on its way; wait for the server's verdict.
    pub sent: bool,
    /// What the user had typed before the form took over the input box.
    pub stash: String,
}

/// Rows a question offers to pick from.
pub fn rows(question: &Question) -> usize {
    match question.kind {
        Kind::Single | Kind::Multi => question.options.len(),
        Kind::Rating => 5,
        Kind::Boolean => 2,
        Kind::Text | Kind::Number { .. } => 0,
    }
}

pub fn typed(question: &Question) -> bool {
    matches!(question.kind, Kind::Text | Kind::Number { .. })
}

impl Draft {
    pub fn new(form: &Form, stash: String) -> Self {
        Self {
            id: form.id.clone(),
            step: 0,
            answers: form.questions.iter().map(|q| q.default.clone()).collect(),
            cursor: 0,
            picked: Vec::new(),
            error: None,
            sent: false,
            stash,
        }
    }

    /// Set up the current question from its saved answer. Returns the text
    /// the input box should hold for a typed question.
    pub fn load(&mut self, form: &Form) -> Option<String> {
        let question = form.questions.get(self.step)?;
        let answer = self.answers.get(self.step).cloned().flatten();
        self.error = None;
        self.cursor = 0;
        self.picked = vec![false; rows(question)];
        match (&question.kind, answer) {
            (Kind::Single, Some(Answer::Choice(id))) => {
                self.cursor = question
                    .options
                    .iter()
                    .position(|o| o.id == id)
                    .unwrap_or(0);
            }
            (Kind::Single | Kind::Multi, Some(Answer::Text(text))) => return Some(text),
            (Kind::Multi, Some(Answer::Choices(ids))) => {
                let mut custom = Vec::new();
                for id in ids {
                    match question.options.iter().position(|o| o.id == id) {
                        Some(index) => self.picked[index] = true,
                        None => custom.push(id),
                    }
                }
                if !custom.is_empty() {
                    return Some(custom.join(", "));
                }
            }
            (Kind::Rating, Some(Answer::Rating(n))) => self.cursor = (n as usize).clamp(1, 5) - 1,
            (Kind::Boolean, Some(Answer::Bool(value))) => self.cursor = usize::from(!value),
            (Kind::Text | Kind::Number { .. }, Some(answer)) => {
                return Some(match answer {
                    Answer::Number(n) => n.to_string(),
                    Answer::Text(text) => text,
                    _ => String::new(),
                })
            }
            (Kind::Text | Kind::Number { .. }, None) => return Some(String::new()),
            _ => {}
        }
        None
    }

    /// The answer the current question would get from the highlighted row,
    /// the toggles, and whatever is typed in the input box. Typed text on a
    /// choice question is a custom answer, which only `ask_form` takes.
    pub fn answer(&self, form: &Form, typed_text: &str) -> Result<Option<Answer>, String> {
        let question = &form.questions[self.step];
        let custom = typed_text.trim();
        let custom_ok = matches!(form.source, Source::AskForm);
        if !custom.is_empty() && !custom_ok && !typed(question) {
            return Err("Pick one of the choices — this form takes no typed answer".into());
        }
        let answer = match question.kind {
            Kind::Single if !custom.is_empty() => Some(Answer::Text(custom.to_string())),
            Kind::Single => question
                .options
                .get(self.cursor)
                .map(|option| Answer::Choice(option.id.clone())),
            Kind::Multi => {
                let mut ids: Vec<String> = question
                    .options
                    .iter()
                    .zip(&self.picked)
                    .filter(|(_, picked)| **picked)
                    .map(|(option, _)| option.id.clone())
                    .collect();
                if !custom.is_empty() {
                    ids.push(custom.to_string());
                }
                (!ids.is_empty()).then_some(Answer::Choices(ids))
            }
            Kind::Text | Kind::Number { .. } => question.parse_text(typed_text)?,
            Kind::Rating => Some(Answer::Rating(self.cursor as u8 + 1)),
            Kind::Boolean => Some(Answer::Bool(self.cursor == 0)),
        };
        question.check(answer.as_ref())?;
        Ok(answer)
    }
}

/// The form card for the live area.
pub fn lines(form: &Form, draft: &Draft, width: usize, p: &Palette) -> Vec<Line<'static>> {
    let accent = p.style(p.agent);
    let bar = || vec![Span::styled("  │ ", accent)];
    let mut lines = Vec::new();
    let mut header = vec![
        Span::styled("◆ ", accent),
        Span::styled(
            form.title.clone(),
            p.style(p.text).add_modifier(Modifier::BOLD),
        ),
    ];
    if let Some(asker) = &form.asker {
        header.push(Span::styled(format!("  from {asker}"), p.style(p.muted)));
    }
    if form.questions.len() > 1 && !matches!(form.source, Source::Url { .. }) {
        header.push(Span::styled(
            format!("  {}/{}", draft.step + 1, form.questions.len()),
            p.style(p.muted),
        ));
    }
    lines.push(Line::from(header));
    for text in form.message.iter().chain(form.description.iter()) {
        for row in text.lines() {
            lines.extend(render::wrap(
                vec![Span::styled(row.to_string(), p.style(p.muted))],
                width,
                &bar(),
            ));
        }
    }

    let hint = |text: &str| Line::from(Span::styled(format!("  {text}"), p.style(p.faint)));
    let error = form.error.as_ref().or(draft.error.as_ref());

    if let Source::Url { url, opened } = &form.source {
        lines.extend(render::wrap(
            vec![Span::styled(url.clone(), p.style(p.info))],
            width,
            &bar(),
        ));
        lines.push(if *opened {
            hint("Waiting for you to finish in the browser… · esc cancel")
        } else {
            hint("enter open in your browser · ctrl+x decline · esc cancel")
        });
        return lines;
    }
    if form.unsupported {
        lines.push(Line::from(Span::styled(
            "  This form has fields the terminal cannot show. Answer it in the Grove web UI.",
            p.style(p.warn),
        )));
        lines.push(hint("esc cancel the request"));
        return lines;
    }
    if draft.sent && error.is_none() {
        lines.push(hint("Sending your answers…"));
        return lines;
    }

    let Some(question) = form.questions.get(draft.step) else {
        return lines;
    };
    let mut title = vec![
        Span::styled("  ? ", accent),
        Span::styled(question.title.clone(), p.style(p.text)),
    ];
    if question.required {
        title.push(Span::styled(" *", p.style(p.error)));
    }
    lines.push(Line::from(title));
    if let Some(description) = &question.description {
        lines.extend(render::wrap(
            vec![Span::styled(description.clone(), p.style(p.muted))],
            width,
            &[Span::raw("    ")],
        ));
    }

    let labels: Vec<(String, Option<String>)> = match question.kind {
        Kind::Single | Kind::Multi => question
            .options
            .iter()
            .map(|option| (option.label.clone(), option.description.clone()))
            .collect(),
        Kind::Rating => (1..=5)
            .map(|n| (format!("{}{}", "★".repeat(n), "☆".repeat(5 - n)), None))
            .collect(),
        Kind::Boolean => vec![("Yes".into(), None), ("No".into(), None)],
        Kind::Text | Kind::Number { .. } => Vec::new(),
    };
    let start = draft.cursor.saturating_sub(OPTION_ROWS - 1);
    if start > 0 {
        lines.push(hint(&format!("  ↑ {start} more")));
    }
    for (index, (label, description)) in labels.iter().enumerate().skip(start).take(OPTION_ROWS) {
        let selected = index == draft.cursor;
        let mark = match question.kind {
            Kind::Multi if draft.picked.get(index) == Some(&true) => "◉ ",
            Kind::Multi => "○ ",
            _ => "",
        };
        let mut spans = vec![
            Span::styled(if selected { "  ❯ " } else { "    " }, p.style(p.info)),
            Span::styled(format!("{} ", index + 1), p.style(p.faint)),
            Span::styled(mark, p.style(p.accent)),
            Span::styled(
                label.clone(),
                if selected {
                    p.style(p.text).add_modifier(Modifier::BOLD)
                } else {
                    p.style(p.text)
                },
            ),
        ];
        if let Some(description) = description {
            spans.push(Span::styled(format!("  {description}"), p.style(p.muted)));
        }
        let mut line = Line::from(spans);
        if selected {
            line.style = Style::default().bg(p.panel);
        }
        lines.push(line);
    }
    let shown = start + OPTION_ROWS;
    if labels.len() > shown {
        lines.push(hint(&format!("  ↓ {} more", labels.len() - shown)));
    }
    if let Some(error) = error {
        lines.push(Line::from(Span::styled(
            format!("  ✗ {error}"),
            p.style(p.error),
        )));
    }

    let mut keys = Vec::new();
    match question.kind {
        Kind::Single => keys.push("↑↓ / 1–9 choose · enter confirm"),
        Kind::Multi => keys.push("↑↓ move · space / 1–9 toggle · enter confirm"),
        Kind::Rating => keys.push("1–5 rate · enter confirm"),
        Kind::Boolean => keys.push("y / n · enter confirm"),
        Kind::Text | Kind::Number { .. } => keys.push("type below · enter confirm"),
    }
    if matches!(form.source, Source::AskForm) && matches!(question.kind, Kind::Single | Kind::Multi)
    {
        keys.push("or type your own answer");
    }
    if !question.required {
        keys.push("tab skip");
    }
    if draft.step > 0 {
        keys.push("shift+tab back");
    }
    if form.is_elicitation() {
        keys.push("ctrl+x decline");
    }
    keys.push(if form.is_elicitation() {
        "esc cancel"
    } else {
        "esc dismiss"
    });
    lines.push(hint(&keys.join(" · ")));
    lines
}

/// Scrollback summary of answers sent to an elicitation.
pub fn summary(
    form: &Form,
    answers: &[Option<Answer>],
    width: usize,
    p: &Palette,
) -> Vec<Line<'static>> {
    let mut lines = vec![Line::from(vec![
        Span::styled("✓ ", p.style(p.accent)),
        Span::styled(format!("Answered {}", form.title), p.style(p.muted)),
    ])];
    for (question, answer) in form.questions.iter().zip(answers) {
        lines.extend(render::wrap(
            vec![
                Span::styled(format!("{}: ", question.title), p.style(p.muted)),
                Span::styled(question.describe(answer.as_ref()), p.style(p.text)),
            ],
            width,
            &[Span::styled("  ⎿ ", p.style(p.faint))],
        ));
    }
    lines.push(Line::default());
    lines
}

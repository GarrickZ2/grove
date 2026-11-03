//! Turn chat blocks into styled, pre-wrapped terminal lines.
//!
//! Lines are wrapped here (not by ratatui) because finished blocks are
//! printed into the terminal's own scrollback, which needs an exact height.

use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use unicode_width::{UnicodeWidthChar, UnicodeWidthStr};

use super::model::{Block, Diff, Level, PlanEntry, Tool, ToolStatus};
use crate::theme::ThemeColors;

/// The CLI's view of the active Grove theme.
#[derive(Clone)]
pub struct Palette {
    pub text: Color,
    pub muted: Color,
    pub faint: Color,
    pub accent: Color,
    pub info: Color,
    pub warn: Color,
    pub error: Color,
    pub agent: Color,
    pub panel: Color,
    pub border: Color,
    /// Keys and selections, as in the rest of Grove's terminal UI.
    pub highlight: Color,
    pub logo: Color,
    pub bg: Color,
    /// Card color blocks, as on the TUI's project cards.
    pub accent_palette: [Color; 10],
}

impl Palette {
    pub fn load() -> Self {
        Self::for_theme(Self::configured())
    }

    /// The theme the config asks for.
    pub fn configured() -> crate::theme::Theme {
        let config = crate::storage::config::load_config();
        crate::theme::configured_theme(&config.theme, crate::theme::detect_system_theme())
    }

    pub fn for_theme(theme: crate::theme::Theme) -> Self {
        Self::from_colors(&crate::theme::get_theme_colors(theme))
    }

    fn from_colors(colors: &ThemeColors) -> Self {
        Self {
            text: colors.text,
            muted: colors.muted,
            faint: colors.border,
            accent: colors.status_live,
            info: colors.info,
            warn: colors.warning,
            error: colors.error,
            agent: colors.highlight,
            panel: colors.bg_secondary,
            border: colors.border,
            highlight: colors.highlight,
            logo: colors.logo,
            bg: colors.bg,
            accent_palette: colors.accent_palette,
        }
    }

    pub fn style(&self, color: Color) -> Style {
        Style::default().fg(color)
    }
}

/// Wrap styled spans to `width` columns, breaking on spaces where possible
/// and anywhere for CJK or overlong words. A `prefix` repeats on every row.
pub fn wrap(
    spans: Vec<Span<'static>>,
    width: usize,
    prefix: &[Span<'static>],
) -> Vec<Line<'static>> {
    let prefix_width: usize = prefix.iter().map(|span| span.content.width()).sum();
    let room = width.saturating_sub(prefix_width).max(8);
    let mut lines = Vec::new();
    let mut row: Vec<Span<'static>> = prefix.to_vec();
    let mut used = 0usize;

    let flush = |row: &mut Vec<Span<'static>>, used: &mut usize, lines: &mut Vec<Line<'static>>| {
        lines.push(Line::from(std::mem::replace(row, prefix.to_vec())));
        *used = 0;
    };

    for span in spans {
        let style = span.style;
        // Split into words that keep their trailing space.
        let mut word = String::new();
        let mut pieces: Vec<String> = Vec::new();
        for ch in span.content.chars() {
            word.push(ch);
            if ch == ' ' || ch.width().unwrap_or(0) > 1 {
                pieces.push(std::mem::take(&mut word));
            }
        }
        if !word.is_empty() {
            pieces.push(word);
        }
        for piece in pieces {
            let piece_width = piece.width();
            if used + piece_width > room && used > 0 {
                flush(&mut row, &mut used, &mut lines);
                if piece == " " {
                    continue;
                }
            }
            if piece_width > room {
                // Hard-break a word longer than a whole row.
                let mut chunk = String::new();
                for ch in piece.chars() {
                    let w = ch.width().unwrap_or(0);
                    if used + w > room {
                        row.push(Span::styled(std::mem::take(&mut chunk), style));
                        flush(&mut row, &mut used, &mut lines);
                    }
                    chunk.push(ch);
                    used += w;
                }
                row.push(Span::styled(chunk, style));
            } else {
                used += piece_width;
                row.push(Span::styled(piece, style));
            }
        }
    }
    if row.len() > prefix.len() || lines.is_empty() {
        lines.push(Line::from(row));
    }
    lines
}

fn plain(text: impl Into<String>, style: Style) -> Vec<Span<'static>> {
    vec![Span::styled(text.into(), style)]
}

/// Inline markdown: `code`, **bold**. Anything else is literal.
fn inline_md(text: &str, base: Style, p: &Palette) -> Vec<Span<'static>> {
    let mut spans = Vec::new();
    let mut rest = text;
    while !rest.is_empty() {
        let tick = rest.find('`');
        let bold = rest.find("**");
        let next = match (tick, bold) {
            (Some(t), Some(b)) => Some(t.min(b)),
            (t, b) => t.or(b),
        };
        let Some(start) = next else {
            spans.push(Span::styled(rest.to_string(), base));
            break;
        };
        if start > 0 {
            spans.push(Span::styled(rest[..start].to_string(), base));
        }
        let is_code = rest[start..].starts_with('`');
        let marker = if is_code { "`" } else { "**" };
        let body = &rest[start + marker.len()..];
        match body.find(marker) {
            Some(end) => {
                let style = if is_code {
                    base.fg(p.info)
                } else {
                    base.add_modifier(Modifier::BOLD)
                };
                spans.push(Span::styled(body[..end].to_string(), style));
                rest = &body[end + marker.len()..];
            }
            None => {
                spans.push(Span::styled(rest[start..].to_string(), base));
                break;
            }
        }
    }
    spans
}

/// A light markdown pass good enough for agent replies: headings, bullets,
/// numbered lists, fenced code, quotes and inline code/bold.
pub fn markdown(text: &str, width: usize, p: &Palette) -> Vec<Line<'static>> {
    let base = p.style(p.text);
    let mut lines = Vec::new();
    let mut in_code = false;
    for raw in text.trim_end().lines() {
        let trimmed = raw.trim_start();
        if trimmed.starts_with("```") {
            in_code = !in_code;
            continue;
        }
        if in_code {
            let prefix = vec![Span::styled("  │ ", p.style(p.faint))];
            lines.extend(wrap(plain(raw, p.style(p.info)), width, &prefix));
            continue;
        }
        if trimmed.is_empty() {
            lines.push(Line::default());
            continue;
        }
        if let Some(heading) = trimmed.strip_prefix('#') {
            let heading = heading.trim_start_matches('#').trim();
            lines.extend(wrap(
                inline_md(heading, base.add_modifier(Modifier::BOLD), p),
                width,
                &[],
            ));
            continue;
        }
        let indent = raw.len() - trimmed.len();
        let pad = " ".repeat(indent.min(8));
        if let Some(item) = trimmed
            .strip_prefix("- ")
            .or_else(|| trimmed.strip_prefix("* "))
        {
            let first = vec![Span::raw(pad.clone()), Span::styled("• ", p.style(p.muted))];
            let mut wrapped = wrap(inline_md(item, base, p), width, &first);
            for line in wrapped.iter_mut().skip(1) {
                line.spans[0] = Span::raw(format!("{pad}  "));
                line.spans.remove(1);
            }
            lines.extend(wrapped);
            continue;
        }
        if let Some(rest) = trimmed.strip_prefix("> ") {
            let prefix = vec![Span::styled("│ ", p.style(p.faint))];
            lines.extend(wrap(inline_md(rest, p.style(p.muted), p), width, &prefix));
            continue;
        }
        lines.extend(wrap(inline_md(raw, base, p), width, &[]));
    }
    lines
}

fn status_dot(status: &ToolStatus, p: &Palette, frame: usize) -> Span<'static> {
    const SPIN: [&str; 4] = ["◐", "◓", "◑", "◒"];
    match status {
        ToolStatus::Done => Span::styled("● ", p.style(p.accent)),
        ToolStatus::Failed => Span::styled("● ", p.style(p.error)),
        ToolStatus::Running => Span::styled(format!("{} ", SPIN[frame % 4]), p.style(p.info)),
        ToolStatus::Pending => Span::styled("○ ", p.style(p.muted)),
    }
}

fn tail(text: &str, max: usize) -> (Vec<&str>, usize) {
    let lines: Vec<&str> = text.trim_end().lines().collect();
    let skipped = lines.len().saturating_sub(max);
    (lines[skipped..].to_vec(), skipped)
}

fn diff_lines(diff: &Diff, width: usize, p: &Palette, max: usize) -> Vec<Line<'static>> {
    let mut out = Vec::new();
    let changes = similar::TextDiff::from_lines(&diff.old_text, &diff.new_text);
    let (mut added, mut removed) = (0, 0);
    let mut rows: Vec<(char, String)> = Vec::new();
    for change in changes.iter_all_changes() {
        let sign = match change.tag() {
            similar::ChangeTag::Insert => {
                added += 1;
                '+'
            }
            similar::ChangeTag::Delete => {
                removed += 1;
                '-'
            }
            similar::ChangeTag::Equal => continue,
        };
        rows.push((sign, change.value().trim_end_matches('\n').to_string()));
    }
    out.push(Line::from(vec![
        Span::raw("    "),
        Span::styled(diff.path.clone(), p.style(p.muted)),
        Span::raw("  "),
        Span::styled(format!("+{added}"), p.style(p.accent)),
        Span::raw(" "),
        Span::styled(format!("-{removed}"), p.style(p.error)),
    ]));
    let shown = rows.len().min(max);
    for (sign, text) in &rows[..shown] {
        let color = if *sign == '+' { p.accent } else { p.error };
        let prefix = vec![Span::styled(format!("    {sign} "), p.style(color))];
        out.extend(wrap(plain(text.clone(), p.style(color)), width, &prefix));
    }
    if rows.len() > shown {
        out.push(Line::from(Span::styled(
            format!("    … {} more changed lines", rows.len() - shown),
            p.style(p.muted),
        )));
    }
    out
}

pub fn tool(
    tool: &Tool,
    width: usize,
    p: &Palette,
    frame: usize,
    verbose: bool,
) -> Vec<Line<'static>> {
    let title = if tool.title.is_empty() {
        tool.id.clone()
    } else {
        tool.title.clone()
    };
    let mut head = vec![Span::styled(
        title,
        p.style(p.text).add_modifier(Modifier::BOLD),
    )];
    if let Some(location) = tool.locations.first() {
        if !tool.title.contains(location.as_str()) {
            head.push(Span::styled(format!("  {location}"), p.style(p.muted)));
        }
    }
    let mut lines = wrap(head, width, &[status_dot(&tool.status, p, frame)]);
    // Only the first row carries the dot; continuation rows indent.
    for line in lines.iter_mut().skip(1) {
        line.spans[0] = Span::raw("  ");
    }
    for diff in &tool.diffs {
        lines.extend(diff_lines(diff, width, p, if verbose { 400 } else { 8 }));
    }
    let output = tool.output.trim();
    if tool.diffs.is_empty() && !output.is_empty() && !verbose {
        // Collapsed: commands show their last lines, everything else one
        // line of summary. ctrl+o shows it all.
        let command = tool.kind == "execute" || !tool.terminal_ids.is_empty();
        let count = output.lines().count();
        if !command {
            let first = output
                .lines()
                .find(|l| !l.trim().is_empty())
                .unwrap_or("")
                .trim();
            let structured = first.starts_with('{') || first.starts_with('[');
            let summary = if structured || count > 1 {
                format!(
                    "{count} line{} of output",
                    if count == 1 { "" } else { "s" }
                )
            } else {
                first.to_string()
            };
            let room = width.saturating_sub(6);
            let summary: String = if unicode_width::UnicodeWidthStr::width(summary.as_str()) > room
            {
                let mut cut = String::new();
                for ch in summary.chars() {
                    if unicode_width::UnicodeWidthStr::width(cut.as_str()) + 2 > room {
                        break;
                    }
                    cut.push(ch);
                }
                cut + "…"
            } else {
                summary
            };
            lines.push(Line::from(vec![
                Span::styled("  ⎿ ", p.style(p.faint)),
                Span::styled(summary, p.style(p.muted)),
            ]));
            return lines;
        }
    }
    if tool.diffs.is_empty() && !output.is_empty() {
        let max = if verbose { 400 } else { 3 };
        let (rows, skipped) = tail(&tool.output, max);
        let start = lines.len();
        let prefix = vec![Span::raw("    ")];
        if skipped > 0 {
            lines.push(Line::from(vec![
                prefix[0].clone(),
                Span::styled(format!("… {skipped} earlier lines"), p.style(p.muted)),
            ]));
        }
        for row in rows {
            lines.extend(wrap(plain(row, p.style(p.muted)), width, &prefix));
        }
        // The elbow marks only the first output row.
        if let Some(first) = lines.get_mut(start) {
            first.spans[0] = Span::styled("  ⎿ ", p.style(p.faint));
        }
    }
    lines
}

pub fn plan(entries: &[PlanEntry], width: usize, p: &Palette) -> Vec<Line<'static>> {
    let mut lines = vec![Line::from(Span::styled("  Plan", p.style(p.muted)))];
    for entry in entries {
        let (mark, style) = match entry.status.as_str() {
            "completed" => ("✓ ", p.style(p.muted).add_modifier(Modifier::CROSSED_OUT)),
            "in_progress" => ("▸ ", p.style(p.text)),
            _ => ("○ ", p.style(p.muted)),
        };
        let mark_style = match entry.status.as_str() {
            "completed" => p.style(p.accent),
            "in_progress" => p.style(p.info),
            _ => p.style(p.muted),
        };
        lines.extend(wrap(
            plain(entry.content.clone(), style),
            width,
            &[Span::raw("  "), Span::styled(mark, mark_style)],
        ));
    }
    lines
}

/// Render one block. `frame` animates spinners for live blocks.
pub fn block(
    block: &Block,
    width: usize,
    p: &Palette,
    frame: usize,
    verbose: bool,
) -> Vec<Line<'static>> {
    let mut lines = match block {
        Block::User { text, sender } => {
            let mut lines = Vec::new();
            if let Some(sender) = sender {
                lines.push(Line::from(Span::styled(
                    format!("  from {sender}"),
                    p.style(p.muted),
                )));
            }
            let prefix = vec![Span::styled("❯ ", p.style(p.muted))];
            for raw in text.trim_end().lines() {
                lines.extend(wrap(plain(raw, p.style(p.text)), width, &prefix));
            }
            for line in &mut lines {
                line.style = Style::default().bg(p.panel);
            }
            lines
        }
        Block::Agent { text, .. } => markdown(text, width, p),
        Block::Thought { text, .. } => {
            if verbose {
                wrap(
                    plain(text.trim(), p.style(p.muted).add_modifier(Modifier::ITALIC)),
                    width,
                    &[Span::styled("✻ ", p.style(p.agent))],
                )
            } else {
                vec![Line::from(vec![
                    Span::styled("✻ ", p.style(p.agent)),
                    Span::styled("Thinking", p.style(p.muted)),
                    Span::styled("  · ctrl+o to expand", p.style(p.faint)),
                ])]
            }
        }
        Block::Tool(t) => tool(t, width, p, frame, verbose),
        Block::Plan(entries) => plan(entries, width, p),
        Block::Notice { level, text } => {
            let (mark, color) = match level {
                Level::Info => ("ℹ ", p.info),
                Level::Warn => ("! ", p.warn),
                Level::Error => ("✗ ", p.error),
            };
            wrap(
                plain(text.clone(), p.style(color)),
                width,
                &[Span::styled(mark, p.style(color))],
            )
        }
        Block::TurnEnd {
            interrupted,
            seconds,
            tokens,
        } => {
            // A finished turn needs no marker; only an interruption does.
            let _ = (seconds, tokens);
            if !*interrupted {
                return Vec::new();
            }
            vec![Line::from(Span::styled("  ⎿ Interrupted", p.style(p.warn)))]
        }
        Block::Shell {
            command,
            output,
            exit_code,
        } => {
            let mut lines = vec![Line::from(vec![
                Span::styled("! ", p.style(p.warn)),
                Span::styled(
                    command.clone(),
                    p.style(p.text).add_modifier(Modifier::BOLD),
                ),
            ])];
            let (rows, _) = tail(output, if verbose { 400 } else { 8 });
            for row in rows {
                lines.extend(wrap(
                    plain(row, p.style(p.muted)),
                    width,
                    &[Span::styled("  ⎿ ", p.style(p.faint))],
                ));
            }
            if let Some(code) = exit_code.filter(|code| *code != 0) {
                lines.push(Line::from(Span::styled(
                    format!("  exit {code}"),
                    p.style(p.error),
                )));
            }
            lines
        }
        Block::Subagent {
            title,
            status,
            preview,
        } => {
            let color = match status.as_str() {
                "Completed" | "Idle" => p.accent,
                "Failed" => p.error,
                _ => p.warn,
            };
            let mut lines = vec![Line::from(vec![
                Span::styled("↳ ", p.style(color)),
                Span::styled(title.clone(), p.style(p.text).add_modifier(Modifier::BOLD)),
                Span::styled(format!("  {status}"), p.style(p.muted)),
            ])];
            if !preview.is_empty() {
                lines.extend(wrap(
                    plain(preview.clone(), p.style(p.muted)),
                    width,
                    &[Span::styled("  ⎿ ", p.style(p.faint))],
                ));
            }
            lines
        }
        Block::Exchange {
            sender,
            recipient,
            text,
            ..
        } => {
            let route = match (sender, recipient) {
                (Some(from), Some(to)) => format!("{from} → {to}"),
                (Some(from), None) => from.clone(),
                (None, Some(to)) => format!("→ {to}"),
                (None, None) => "Agent message".into(),
            };
            let mut lines = vec![Line::from(vec![
                Span::styled("✉ ", p.style(p.agent)),
                Span::styled(route, p.style(p.muted)),
            ])];
            let body = if verbose {
                text.trim().to_string()
            } else {
                let (rows, hidden) = tail_head(text.trim(), 6);
                if hidden > 0 {
                    format!("{rows}\n… {hidden} more lines · ctrl+o to expand")
                } else {
                    rows
                }
            };
            for row in markdown(&body, width.saturating_sub(2), p) {
                let mut spans = vec![Span::styled("│ ", p.style(p.faint))];
                spans.extend(row.spans);
                lines.push(Line::from(spans));
            }
            lines
        }
        Block::Document { title, text } => {
            let mut lines = vec![Line::from(vec![
                Span::styled("▤ ", p.style(p.info)),
                Span::styled(title.clone(), p.style(p.text).add_modifier(Modifier::BOLD)),
            ])];
            for row in markdown(text.trim(), width.saturating_sub(2), p) {
                let mut spans = vec![Span::styled("│ ", p.style(p.faint))];
                spans.extend(row.spans);
                lines.push(Line::from(spans));
            }
            lines
        }
    };
    // Breathing room between blocks, as in the design.
    if !lines.is_empty() {
        lines.push(Line::default());
    }
    lines
}

/// The first `max` lines of `text`, and how many were left out.
fn tail_head(text: &str, max: usize) -> (String, usize) {
    let lines: Vec<&str> = text.lines().collect();
    if lines.len() <= max {
        (text.to_string(), 0)
    } else {
        (lines[..max].join("\n"), lines.len() - max)
    }
}

pub fn format_elapsed(seconds: u64) -> String {
    if seconds >= 60 {
        format!("{}m {:02}s", seconds / 60, seconds % 60)
    } else {
        format!("{seconds}s")
    }
}

pub fn compact_number(value: u64) -> String {
    if value >= 1000 {
        format!("{:.1}k", value as f64 / 1000.0)
    } else {
        value.to_string()
    }
}

/// Plain-text form of a block for non-interactive output (no colors).
pub fn plain_text(block: &Block) -> Option<String> {
    Some(match block {
        Block::User { text, .. } => format!("❯ {}", text.trim_end()),
        Block::Agent { text, .. } => text.trim_end().to_string(),
        Block::Thought { .. } => return None,
        Block::Tool(tool) => {
            let mark = match tool.status {
                ToolStatus::Done => "●",
                ToolStatus::Failed => "✗",
                _ => "○",
            };
            let title = if tool.title.is_empty() {
                &tool.id
            } else {
                &tool.title
            };
            format!("{mark} {title}")
        }
        Block::Plan(entries) => entries
            .iter()
            .map(|entry| {
                let mark = match entry.status.as_str() {
                    "completed" => "✓",
                    "in_progress" => "▸",
                    _ => "○",
                };
                format!("  {mark} {}", entry.content)
            })
            .collect::<Vec<_>>()
            .join("\n"),
        Block::Notice { text, .. } => format!("! {text}"),
        Block::TurnEnd { .. } => return None,
        Block::Shell {
            command, output, ..
        } => format!("! {command}\n{}", output.trim_end()),
        Block::Subagent {
            title,
            status,
            preview,
        } => {
            if preview.is_empty() {
                format!("↳ {title} · {status}")
            } else {
                format!("↳ {title} · {status}\n  {preview}")
            }
        }
        Block::Exchange {
            sender,
            recipient,
            text,
            ..
        } => format!(
            "✉ {} → {}\n{}",
            sender.as_deref().unwrap_or("agent"),
            recipient.as_deref().unwrap_or("agent"),
            text.trim_end()
        ),
        Block::Document { title, text } => format!("▤ {title}\n{}", text.trim_end()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn text(lines: &[Line]) -> Vec<String> {
        lines
            .iter()
            .map(|line| line.spans.iter().map(|s| s.content.as_ref()).collect())
            .collect()
    }

    #[test]
    fn wraps_on_spaces_and_cjk() {
        let lines = wrap(vec![Span::raw("hello world again")], 10, &[]);
        assert_eq!(text(&lines), vec!["hello ", "world ", "again"]);
        let lines = wrap(vec![Span::raw("中文中文中文")], 8, &[]);
        assert!(lines.iter().all(|line| line.width() <= 8));
        assert_eq!(lines.len(), 2);
    }

    #[test]
    fn prefix_repeats() {
        let lines = wrap(vec![Span::raw("aaaa bbbb")], 8, &[Span::raw("> ")]);
        assert_eq!(text(&lines), vec!["> aaaa ", "> bbbb"]);
    }

    #[test]
    fn markdown_handles_code_and_bullets() {
        let p = Palette::from_colors(&crate::theme::get_theme_colors(crate::theme::Theme::Dark));
        let lines = markdown("# Title\n- one `x`\n```\nlet a = 1;\n```", 40, &p);
        let rendered = text(&lines);
        assert_eq!(rendered[0], "Title");
        assert_eq!(rendered[1], "• one x");
        assert!(rendered[2].contains("let a = 1;"));
    }
}

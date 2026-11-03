//! Markdown ↔ Slack text. Outbound: CommonMark → mrkdwn. Inbound: Slack's
//! escaped markup → plain text for the agent.
use crate::connect::markdown::{heading, inlines, segments, Inline, Segment};
use once_cell::sync::Lazy;
use regex::Regex;

/// Slack's client intercepts every message starting with "/", so Grove
/// commands travel as `/grove <command>`; hints in replies say the same.
static COMMAND: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(^|[\s(])/(new|clear|target|config|status|cancel|skill|respond|answer|submit|decline|help)\b")
        .unwrap()
});

fn escape(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

fn prose(text: &str) -> String {
    COMMAND
        .replace_all(&escape(text), "$1/grove $2")
        .into_owned()
}

pub fn mrkdwn(markdown: &str) -> String {
    let mut out = String::new();
    for segment in segments(markdown) {
        match segment {
            Segment::Text(text) => {
                for line in text.split_inclusive('\n') {
                    let (body, newline) = match line.strip_suffix('\n') {
                        Some(body) => (body, "\n"),
                        None => (line, ""),
                    };
                    if let Some(title) = heading(body) {
                        out.push_str(&format!("*{}*{newline}", prose(title)));
                        continue;
                    }
                    for span in inlines(line) {
                        match span {
                            Inline::Text(text) => out.push_str(&prose(text)),
                            Inline::Code(code) => out.push_str(&format!("`{}`", escape(code))),
                            Inline::Bold(text) => out.push_str(&format!("*{}*", prose(text))),
                            Inline::Strike(text) => out.push_str(&format!("~{}~", prose(text))),
                            Inline::Link { text, url } => out.push_str(&format!(
                                "<{}|{}>",
                                url.replace(['<', '>', '|'], ""),
                                escape(text).replace('|', "¦")
                            )),
                        }
                    }
                }
            }
            Segment::Code { body, .. } => {
                if !out.is_empty() && !out.ends_with('\n') {
                    out.push('\n');
                }
                out.push_str(&format!("```\n{}\n```\n", escape(body)));
            }
        }
    }
    out.trim_end().to_owned()
}

static MARKUP: Lazy<Regex> = Lazy::new(|| Regex::new(r"<([^<>|]+)(?:\|([^<>]*))?>").unwrap());

/// Slack message text → what the user typed: links and mentions lose their
/// angle-bracket markup and HTML entities are decoded.
pub fn plain(text: &str) -> String {
    let replaced = MARKUP.replace_all(text, |captures: &regex::Captures| {
        let target = &captures[1];
        let label = captures.get(2).map(|value| value.as_str());
        match (target.chars().next(), label) {
            (Some('@'), Some(label)) => format!("@{label}"),
            (Some('@' | '#'), None) => target.to_owned(),
            (Some('#'), Some(label)) => format!("#{label}"),
            (Some('!'), _) => format!("@{}", target.trim_start_matches('!')),
            (_, Some(label)) if !label.is_empty() && !target.ends_with(label) => {
                format!("{label} ({target})")
            }
            _ => target.trim_start_matches("mailto:").to_owned(),
        }
    });
    replaced
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&amp;", "&")
}

/// `/grove target project 2` (slash payload text `target project 2`) →
/// the command Grove's text UI expects.
pub fn slash_command(text: &str) -> String {
    let text = text.trim();
    if text.is_empty() {
        return "/help".into();
    }
    format!("/{}", text.trim_start_matches('/'))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn renders_mrkdwn_and_points_hints_at_the_slash_command() {
        assert_eq!(
            mrkdwn("## Plan\nSend /target or **/new** & see [docs](https://x.y/a|b)\n```\na<b\n```\nsrc/new stays"),
            "*Plan*\nSend /grove target or */grove new* &amp; see <https://x.y/ab|docs>\n```\na&lt;b\n```\nsrc/new stays"
        );
        assert_eq!(mrkdwn("`/new` literal"), "`/new` literal");
    }

    #[test]
    fn inbound_markup_becomes_plain_text() {
        assert_eq!(
            plain("see <https://example.com|example.com> and <https://a.b/c|docs> &lt;x&gt; &amp; <@U123> <mailto:a@b.c|a@b.c>"),
            "see https://example.com and docs (https://a.b/c) <x> & @U123 a@b.c"
        );
        assert_eq!(slash_command(" target project 2"), "/target project 2");
        assert_eq!(slash_command(""), "/help");
        assert_eq!(slash_command("/new"), "/new");
    }
}

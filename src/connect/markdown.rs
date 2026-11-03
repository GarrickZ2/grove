//! Minimal Markdown reading shared by IM formatters. Agents reply in
//! CommonMark; Telegram (HTML) and Slack (mrkdwn) each render the same small
//! subset: fenced code, headings, inline code, bold, strikethrough and links.
//! Everything else stays literal text, which both platforms display safely.

#[derive(Debug, PartialEq)]
pub enum Segment<'a> {
    Text(&'a str),
    Code { lang: &'a str, body: &'a str },
}

#[derive(Debug, PartialEq)]
pub enum Inline<'a> {
    Text(&'a str),
    Code(&'a str),
    Bold(&'a str),
    Strike(&'a str),
    Link { text: &'a str, url: &'a str },
}

fn fence(line: &str) -> Option<&str> {
    let trimmed = line.trim_start_matches(' ');
    (line.len() - trimmed.len() <= 3)
        .then_some(trimmed)
        .and_then(|value| value.strip_prefix("```"))
}

/// Splits text into prose and fenced code blocks. An unclosed fence runs to
/// the end, matching how chat clients render a truncated reply.
pub fn segments(text: &str) -> Vec<Segment<'_>> {
    let mut result = Vec::new();
    let mut offset = 0;
    let mut prose_start = 0;
    let mut code: Option<(&str, usize)> = None;
    for line in text.split_inclusive('\n') {
        let start = offset;
        offset += line.len();
        match (code, fence(line.trim_end_matches(['\r', '\n']))) {
            (None, Some(lang)) => {
                if start > prose_start {
                    result.push(Segment::Text(&text[prose_start..start]));
                }
                code = Some((lang.trim(), offset));
            }
            (Some((lang, body)), Some(_)) => {
                result.push(Segment::Code {
                    lang,
                    body: text[body..start].trim_end_matches(['\r', '\n']),
                });
                code = None;
                prose_start = offset;
            }
            _ => {}
        }
    }
    match code {
        Some((lang, body)) => result.push(Segment::Code {
            lang,
            body: text[body.min(text.len())..].trim_end_matches(['\r', '\n']),
        }),
        None if prose_start < text.len() => result.push(Segment::Text(&text[prose_start..])),
        None => {}
    }
    result
}

/// `## Title` → `Some("Title")`.
pub fn heading(line: &str) -> Option<&str> {
    let hashes = line.bytes().take_while(|byte| *byte == b'#').count();
    (1..=6)
        .contains(&hashes)
        .then(|| &line[hashes..])
        .and_then(|rest| rest.strip_prefix(' '))
        .map(str::trim)
}

fn delimited<'a>(rest: &'a str, marker: &str) -> Option<(&'a str, usize)> {
    let body = rest.strip_prefix(marker)?;
    let end = body.find(marker)?;
    let inner = &body[..end];
    (!inner.is_empty() && !inner.starts_with(' ') && !inner.ends_with(' '))
        .then_some((inner, marker.len() * 2 + end))
}

fn link(rest: &str) -> Option<(&str, &str, usize)> {
    let body = rest.strip_prefix('[')?;
    let close = body.find("](")?;
    let text = &body[..close];
    let after = &body[close + 2..];
    let end = after.find(')')?;
    let url = &after[..end];
    let valid = (url.starts_with("https://") || url.starts_with("http://"))
        && !url.contains(char::is_whitespace)
        && !text.is_empty()
        && !text.contains('\n');
    valid.then_some((text, url, 1 + close + 2 + end + 1))
}

/// Inline spans of one prose block. Unmatched markers stay text.
pub fn inlines(text: &str) -> Vec<Inline<'_>> {
    let mut result = Vec::new();
    let mut plain = 0;
    let mut index = 0;
    while index < text.len() {
        let rest = &text[index..];
        let token = if rest.starts_with('`') {
            delimited(rest, "`").map(|(inner, len)| (Inline::Code(inner), len))
        } else if rest.starts_with("**") {
            delimited(rest, "**").map(|(inner, len)| (Inline::Bold(inner), len))
        } else if rest.starts_with("~~") {
            delimited(rest, "~~").map(|(inner, len)| (Inline::Strike(inner), len))
        } else if rest.starts_with('[') {
            link(rest).map(|(text, url, len)| (Inline::Link { text, url }, len))
        } else {
            None
        };
        // Spans never cross a line: chat clients would not render them.
        let token = token.filter(|(_, len)| !text[index..index + len].contains('\n'));
        match token {
            Some((span, len)) => {
                if plain < index {
                    result.push(Inline::Text(&text[plain..index]));
                }
                result.push(span);
                index += len;
                plain = index;
            }
            None => index += rest.chars().next().map_or(1, char::len_utf8),
        }
    }
    if plain < text.len() {
        result.push(Inline::Text(&text[plain..]));
    }
    result
}

fn hard_split(line: &str, max_bytes: usize) -> Vec<&str> {
    let mut parts = Vec::new();
    let mut rest = line;
    while rest.len() > max_bytes {
        let mut end = max_bytes;
        while !rest.is_char_boundary(end) {
            end -= 1;
        }
        parts.push(&rest[..end]);
        rest = &rest[end..];
    }
    if !rest.is_empty() {
        parts.push(rest);
    }
    parts
}

/// Splits Markdown into messages of at most `max_bytes`, preferring line
/// boundaries. A code fence cut by a boundary is closed and reopened so each
/// message renders on its own.
pub fn chunk(text: &str, max_bytes: usize) -> Vec<String> {
    const CLOSE: &str = "\n```";
    let budget = max_bytes.saturating_sub(CLOSE.len() + 1).max(16);
    let mut chunks = Vec::new();
    let mut current = String::new();
    let mut open: Option<String> = None;
    for line in text.split_inclusive('\n') {
        let whole = hard_split(
            line,
            budget.saturating_sub(open.as_ref().map_or(0, String::len) + 1),
        );
        let is_fence = whole.len() == 1 && fence(line.trim_end_matches(['\r', '\n'])).is_some();
        for piece in whole {
            if !current.is_empty() && current.len() + piece.len() > budget {
                if open.is_some() {
                    current.truncate(current.trim_end_matches(['\r', '\n']).len());
                    current.push_str(CLOSE);
                }
                chunks.push(std::mem::take(&mut current));
                if let Some(opening) = &open {
                    current.push_str(opening);
                    current.push('\n');
                }
            }
            current.push_str(piece);
        }
        if is_fence {
            open = match open {
                Some(_) => None,
                None => Some(line.trim_end().to_owned()),
            };
        }
    }
    if !current.trim().is_empty() {
        chunks.push(current);
    }
    chunks
        .into_iter()
        .map(|chunk| chunk.trim_end().to_owned())
        .filter(|chunk| !chunk.is_empty())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn segments_separate_fenced_code_and_keep_unclosed_fences() {
        let text = "intro\n```rust\nfn main() {}\n```\noutro\n```\nopen";
        assert_eq!(
            segments(text),
            vec![
                Segment::Text("intro\n"),
                Segment::Code {
                    lang: "rust",
                    body: "fn main() {}"
                },
                Segment::Text("outro\n"),
                Segment::Code {
                    lang: "",
                    body: "open"
                },
            ]
        );
    }

    #[test]
    fn inlines_match_only_closed_spans_on_one_line() {
        assert_eq!(
            inlines("a **b** `c` ~~d~~ [e](https://x.y) **open\nx**"),
            vec![
                Inline::Text("a "),
                Inline::Bold("b"),
                Inline::Text(" "),
                Inline::Code("c"),
                Inline::Text(" "),
                Inline::Strike("d"),
                Inline::Text(" "),
                Inline::Link {
                    text: "e",
                    url: "https://x.y"
                },
                Inline::Text(" **open\nx**"),
            ]
        );
        assert_eq!(
            inlines("[x](javascript:alert(1))"),
            vec![Inline::Text("[x](javascript:alert(1))")]
        );
        assert_eq!(heading("## Title "), Some("Title"));
        assert_eq!(heading("#hashtag"), None);
    }

    #[test]
    fn chunks_respect_limits_and_reopen_cut_fences() {
        let body = format!("start\n```py\n{}```\nend 🙂", "print(1)\n".repeat(40));
        let parts = chunk(&body, 120);
        assert!(parts.len() > 1);
        assert!(parts.iter().all(|part| part.len() <= 120));
        for part in &parts {
            assert_eq!(part.matches("```").count() % 2, 0, "{part}");
        }
        assert!(parts.last().unwrap().ends_with("end 🙂"));
        let long = "中".repeat(200);
        assert!(chunk(&long, 100).iter().all(|part| part.len() <= 100));
        assert_eq!(chunk(&long, 100).concat(), long);
    }
}

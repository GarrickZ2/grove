//! Markdown → Telegram HTML (`parse_mode=HTML`). Only tags Telegram accepts
//! are emitted, and every text run is escaped; the sender still falls back
//! to plain text if Telegram refuses the entities.
use crate::connect::markdown::{heading, inlines, segments, Inline, Segment};

pub fn escape(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

fn prose(text: &str, out: &mut String) {
    for line in text.split_inclusive('\n') {
        let (body, newline) = match line.strip_suffix('\n') {
            Some(body) => (body, "\n"),
            None => (line, ""),
        };
        if let Some(title) = heading(body) {
            out.push_str(&format!("<b>{}</b>{newline}", escape(title)));
            continue;
        }
        for span in inlines(line) {
            match span {
                Inline::Text(text) => out.push_str(&escape(text)),
                Inline::Code(code) => out.push_str(&format!("<code>{}</code>", escape(code))),
                Inline::Bold(text) => out.push_str(&format!("<b>{}</b>", escape(text))),
                Inline::Strike(text) => out.push_str(&format!("<s>{}</s>", escape(text))),
                Inline::Link { text, url } => out.push_str(&format!(
                    "<a href=\"{}\">{}</a>",
                    escape(url).replace('"', "&quot;"),
                    escape(text)
                )),
            }
        }
    }
}

pub fn html(markdown: &str) -> String {
    let mut out = String::new();
    for segment in segments(markdown) {
        match segment {
            Segment::Text(text) => prose(text, &mut out),
            Segment::Code { lang, body } => {
                let lang = lang
                    .split_whitespace()
                    .next()
                    .filter(|lang| {
                        lang.bytes()
                            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'+' | b'-'))
                    })
                    .unwrap_or_default();
                if !out.is_empty() && !out.ends_with('\n') {
                    out.push('\n');
                }
                if lang.is_empty() {
                    out.push_str(&format!("<pre>{}</pre>\n", escape(body)));
                } else {
                    out.push_str(&format!(
                        "<pre><code class=\"language-{lang}\">{}</code></pre>\n",
                        escape(body)
                    ));
                }
            }
        }
    }
    out.trim_end().to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn renders_supported_markdown_and_escapes_everything_else() {
        assert_eq!(
            html("# Done\nUse **bold** & `a<b>` [docs](https://x.y/?a=1&b=\"2\")\n```rust\nlet x = 1 < 2;\n```\n<script>"),
            "<b>Done</b>\nUse <b>bold</b> &amp; <code>a&lt;b&gt;</code> <a href=\"https://x.y/?a=1&amp;b=&quot;2&quot;\">docs</a>\n<pre><code class=\"language-rust\">let x = 1 &lt; 2;</code></pre>\n&lt;script&gt;"
        );
        assert_eq!(html("```bad\"lang\nx\n```"), "<pre>x</pre>");
    }
}

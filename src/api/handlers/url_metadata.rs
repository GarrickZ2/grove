//! Fetch `<title>` and `<meta name="description">` for a URL.
//!
//! Used by the "Add Link" dialog in Artifacts / Shared Assets to auto-fill
//! a human-readable Name when the user pastes a URL.
//!
//! Fails open: on any error (bad status, timeout, malformed HTML) we return
//! 200 with empty fields so the UI can fall back to `hostname + path tail`.

use axum::{http::StatusCode, Json};
use serde::{Deserialize, Serialize};

use crate::api::error::ApiError;

/// Max bytes of body to read while scanning for <title>. Real pages have
/// these tags near the top; an abusive/slow server cannot stall us.
const MAX_READ_BYTES: usize = 1024 * 1024;
const REQUEST_TIMEOUT_SECS: u64 = 3;

#[derive(Debug, Deserialize)]
pub struct UrlMetadataRequest {
    pub url: String,
}

#[derive(Debug, Serialize, Default)]
pub struct UrlMetadataResponse {
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

pub async fn fetch_url_metadata(
    Json(request): Json<UrlMetadataRequest>,
) -> Result<Json<UrlMetadataResponse>, (StatusCode, Json<ApiError>)> {
    let url = request.url.trim().to_string();
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(ApiError {
                error: "URL must be http(s)".to_string(),
            }),
        ));
    }

    // Do the blocking fetch on a worker thread so we don't stall the runtime.
    let meta = tokio::task::spawn_blocking(move || fetch_blocking(&url))
        .await
        .unwrap_or_else(|_| UrlMetadataResponse::default());

    Ok(Json(meta))
}

fn fetch_blocking(url: &str) -> UrlMetadataResponse {
    let agent = ureq::AgentBuilder::new()
        .timeout(std::time::Duration::from_secs(REQUEST_TIMEOUT_SECS))
        .build();
    let resp = match agent.get(url).call() {
        Ok(r) => r,
        Err(_) => return UrlMetadataResponse::default(),
    };
    use std::io::Read;
    let mut reader = resp.into_reader().take(MAX_READ_BYTES as u64);
    let mut buf = Vec::with_capacity(32 * 1024);
    if reader.read_to_end(&mut buf).is_err() {
        return UrlMetadataResponse::default();
    }
    // Best-effort: assume UTF-8. If decoding fails, lossy is fine — we only
    // need ASCII-compatible tag structure to locate <title>/<meta>.
    let text = String::from_utf8_lossy(&buf);
    UrlMetadataResponse {
        title: extract_title(&text).unwrap_or_default(),
        description: extract_description(&text),
    }
}

/// Extract inner text of the first <title>...</title> (case-insensitive),
/// decode the handful of HTML entities that appear in real titles, and
/// collapse whitespace.
fn extract_title(html: &str) -> Option<String> {
    let lower = html.to_ascii_lowercase();
    let start_tag = lower.find("<title")?;
    let after_open = html[start_tag..].find('>')? + start_tag + 1;
    let rel_close = lower[after_open..].find("</title>")?;
    let raw = &html[after_open..after_open + rel_close];
    let decoded = decode_basic_entities(raw);
    let collapsed = decoded.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.is_empty() {
        None
    } else {
        Some(collapsed)
    }
}

/// Extract content of `<meta name="description" content="...">` or the
/// OpenGraph `og:description` counterpart. Case-insensitive; tolerant of
/// attribute ordering and single-vs-double quotes.
fn extract_description(html: &str) -> Option<String> {
    let lower = html.to_ascii_lowercase();
    let mut search_from = 0usize;
    while let Some(tag_start) = lower[search_from..].find("<meta").map(|i| i + search_from) {
        let tag_end = lower[tag_start..]
            .find('>')
            .map(|i| i + tag_start)
            .unwrap_or(lower.len());
        let tag = &html[tag_start..tag_end];
        let tag_lower = &lower[tag_start..tag_end];
        if contains_attr(tag_lower, "name", "description")
            || contains_attr(tag_lower, "property", "og:description")
        {
            if let Some(content) = extract_attr_value(tag, "content") {
                let decoded = decode_basic_entities(&content);
                let trimmed = decoded.trim();
                if !trimmed.is_empty() {
                    return Some(trimmed.to_string());
                }
            }
        }
        search_from = tag_end + 1;
    }
    None
}

/// True if the tag (lowercased) has `attr="value"` or `attr='value'` exactly.
fn contains_attr(tag_lower: &str, attr: &str, value: &str) -> bool {
    let needle_dq = format!("{attr}=\"{value}\"");
    let needle_sq = format!("{attr}='{value}'");
    tag_lower.contains(&needle_dq) || tag_lower.contains(&needle_sq)
}

/// Extract an attribute's quoted value from a tag (preserving original case).
fn extract_attr_value(tag: &str, attr: &str) -> Option<String> {
    let lower = tag.to_ascii_lowercase();
    let needle = format!("{attr}=");
    let start = lower.find(&needle)? + needle.len();
    let rest = &tag[start..];
    let mut chars = rest.chars();
    let quote = chars.next()?;
    if quote != '"' && quote != '\'' {
        return None;
    }
    let closing = rest[1..].find(quote)?;
    Some(rest[1..1 + closing].to_string())
}

fn decode_basic_entities(s: &str) -> String {
    s.replace("&amp;", "&")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&apos;", "'")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&nbsp;", " ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_title_case_insensitive() {
        let html = "<html><head><TITLE>Hello &amp; World</TITLE></head></html>";
        assert_eq!(extract_title(html).as_deref(), Some("Hello & World"));
    }

    #[test]
    fn collapses_whitespace_in_title() {
        let html = "<title>\n  Foo\n    Bar\n</title>";
        assert_eq!(extract_title(html).as_deref(), Some("Foo Bar"));
    }

    #[test]
    fn extracts_meta_description_double_quotes() {
        let html = r#"<meta name="description" content="Short desc"/>"#;
        assert_eq!(extract_description(html).as_deref(), Some("Short desc"));
    }

    #[test]
    fn extracts_og_description_single_quotes() {
        let html = "<meta property='og:description' content='OG desc'/>";
        assert_eq!(extract_description(html).as_deref(), Some("OG desc"));
    }

    #[test]
    fn missing_title_returns_none() {
        assert_eq!(extract_title("<html><body>no title</body></html>"), None);
    }
}

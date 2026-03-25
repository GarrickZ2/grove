use std::path::PathBuf;

use base64::Engine;

use crate::error::Result;

#[derive(Debug, Clone)]
pub struct StoredAttachment {
    pub name: String,
    pub mime_type: Option<String>,
    pub size: i64,
    pub uri: String,
}

fn chat_dir(project: &str, task_id: &str, chat_id: &str) -> PathBuf {
    super::grove_dir()
        .join("projects")
        .join(project)
        .join("tasks")
        .join(task_id)
        .join("chats")
        .join(chat_id)
}

fn attachments_dir(project: &str, task_id: &str, chat_id: &str) -> PathBuf {
    chat_dir(project, task_id, chat_id).join("attachments")
}

fn sanitize_filename(name: &str) -> String {
    let trimmed = name.trim();
    let base = if trimmed.is_empty() {
        "attachment"
    } else {
        trimmed
    };
    let sanitized: String = base
        .chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '\0' => '_',
            _ if c.is_control() => '_',
            _ => c,
        })
        .collect();
    let sanitized = sanitized.trim_matches('.');
    if sanitized.is_empty() {
        "attachment".to_string()
    } else {
        sanitized.to_string()
    }
}

fn unique_attachment_path(dir: &std::path::Path, file_name: &str) -> PathBuf {
    let candidate = dir.join(file_name);
    if !candidate.exists() {
        return candidate;
    }

    let path = std::path::Path::new(file_name);
    let stem = path
        .file_stem()
        .and_then(|s| s.to_str())
        .filter(|s| !s.is_empty())
        .unwrap_or("attachment");
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");

    for idx in 1..10_000 {
        let suffix = if ext.is_empty() {
            format!("{}-{}", stem, idx)
        } else {
            format!("{}-{}.{}", stem, idx, ext)
        };
        let candidate = dir.join(&suffix);
        if !candidate.exists() {
            return candidate;
        }
    }

    dir.join(format!(
        "{}-{}{}",
        stem,
        chrono::Utc::now().timestamp_millis(),
        if ext.is_empty() {
            String::new()
        } else {
            format!(".{}", ext)
        }
    ))
}

pub fn store_attachment(
    project: &str,
    task_id: &str,
    chat_id: &str,
    name: &str,
    mime_type: Option<&str>,
    data_base64: &str,
) -> Result<StoredAttachment> {
    let dir = attachments_dir(project, task_id, chat_id);
    std::fs::create_dir_all(&dir)?;

    let file_name = sanitize_filename(name);
    let path = unique_attachment_path(&dir, &file_name);
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data_base64)
        .map_err(|e| {
            crate::error::GroveError::InvalidData(format!("Invalid base64 attachment: {}", e))
        })?;
    std::fs::write(&path, &bytes)?;

    let uri = url::Url::from_file_path(&path)
        .map_err(|_| crate::error::GroveError::Session("Invalid attachment path".into()))?
        .to_string();

    Ok(StoredAttachment {
        name: path
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or(file_name.as_str())
            .to_string(),
        mime_type: mime_type.map(|s| s.to_string()).filter(|s| !s.is_empty()),
        size: bytes.len() as i64,
        uri,
    })
}

//! Files a Buddy hands on: the user's attachments (or files on disk) forwarded
//! into another Session, and media read back out of a Session's history.
use crate::acp::{AcpUpdate, ContentBlockData};
use crate::error::{GroveError, Result};
use crate::storage::{chat_attachments, chat_history, workspace};
use base64::Engine;
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

/// Largest file a Buddy may forward (the chat upload limit).
const MAX_FILE_BYTES: u64 = 100 * 1024 * 1024;
/// Images above this go as a file link rather than inline (Claude's image limit).
const MAX_INLINE_IMAGE_BYTES: usize = 5 * 1024 * 1024;
const INLINE_IMAGE_TYPES: [&str; 4] = ["image/jpeg", "image/png", "image/gif", "image/webp"];

/// One file to hand on, read into memory.
#[derive(Debug, Clone, PartialEq)]
pub struct Outgoing {
    pub name: String,
    pub mime_type: String,
    pub bytes: Vec<u8>,
}

fn decode(data: &str) -> Option<Vec<u8>> {
    base64::engine::general_purpose::STANDARD.decode(data).ok()
}

fn file_path(uri: &str) -> Option<PathBuf> {
    url::Url::parse(uri).ok()?.to_file_path().ok()
}

fn guess_mime(path: &Path) -> String {
    mime_guess::from_path(path)
        .first_raw()
        .unwrap_or("application/octet-stream")
        .to_owned()
}

fn file_name(path: &Path) -> String {
    path.file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("attachment")
        .to_owned()
}

fn extension(mime_type: &str) -> &str {
    match mime_type {
        "image/jpeg" => "jpg",
        "image/png" => "png",
        "image/gif" => "gif",
        "image/webp" => "webp",
        "audio/mpeg" => "mp3",
        "audio/wav" => "wav",
        _ => mime_type
            .split('/')
            .nth(1)
            .filter(|ext| ext.chars().all(|c| c.is_ascii_alphanumeric()))
            .unwrap_or("bin"),
    }
}

fn read_file(path: &Path) -> Result<Vec<u8>> {
    let meta = std::fs::metadata(path)
        .map_err(|_| GroveError::not_found(format!("No file at {}", path.display())))?;
    if !meta.is_file() {
        return Err(GroveError::invalid_data(format!(
            "{} is not a file",
            path.display()
        )));
    }
    if meta.len() > MAX_FILE_BYTES {
        return Err(GroveError::invalid_data(format!(
            "{} is larger than 100 MiB",
            path.display()
        )));
    }
    Ok(std::fs::read(path)?)
}

/// Absolute paths or file:// URIs, read so they can be copied into a Session.
pub fn from_paths(paths: &[String]) -> Result<Vec<Outgoing>> {
    paths
        .iter()
        .map(|raw| {
            let path = if raw.starts_with("file://") {
                file_path(raw)
                    .ok_or_else(|| GroveError::invalid_data(format!("Invalid file URI {raw}")))?
            } else {
                PathBuf::from(raw)
            };
            if !path.is_absolute() {
                return Err(GroveError::invalid_data(format!(
                    "Attachment paths must be absolute: {raw}"
                )));
            }
            Ok(Outgoing {
                name: file_name(&path),
                mime_type: guess_mime(&path),
                bytes: read_file(&path)?,
            })
        })
        .collect()
}

/// The bytes behind one prompt block; text carries no file.
fn from_block(block: &ContentBlockData) -> Option<Outgoing> {
    match block {
        ContentBlockData::Image {
            data,
            mime_type,
            uri,
            label,
        } => {
            let path = uri.as_deref().and_then(file_path);
            let bytes = decode(data)
                .filter(|bytes| !bytes.is_empty())
                .or_else(|| path.as_deref().and_then(|p| read_file(p).ok()))?;
            let name = path
                .as_deref()
                .map(file_name)
                .or_else(|| label.clone())
                .unwrap_or_else(|| format!("image.{}", extension(mime_type)));
            Some(Outgoing {
                name,
                mime_type: mime_type.clone(),
                bytes,
            })
        }
        ContentBlockData::Audio {
            data,
            mime_type,
            label,
        } => Some(Outgoing {
            name: label
                .clone()
                .unwrap_or_else(|| format!("audio.{}", extension(mime_type))),
            mime_type: mime_type.clone(),
            bytes: decode(data)?,
        }),
        ContentBlockData::ResourceLink {
            uri,
            name,
            mime_type,
            ..
        } => {
            let path = file_path(uri)?;
            Some(Outgoing {
                name: name.clone(),
                mime_type: mime_type.clone().unwrap_or_else(|| guess_mime(&path)),
                bytes: read_file(&path).ok()?,
            })
        }
        ContentBlockData::Resource {
            uri,
            mime_type,
            text,
            blob,
        } => {
            let bytes = match (text, blob) {
                (Some(text), _) => text.clone().into_bytes(),
                (None, Some(blob)) => decode(blob)?,
                (None, None) => return None,
            };
            Some(Outgoing {
                name: uri.rsplit('/').next().unwrap_or("resource").to_owned(),
                mime_type: mime_type
                    .clone()
                    .unwrap_or_else(|| "application/octet-stream".into()),
                bytes,
            })
        }
        ContentBlockData::Text { .. } => None,
    }
}

/// The attachments of the user's most recent message that had any. Messages
/// Grove or other agents injected (routines, delegation results) are skipped.
pub fn latest_from_user(project: &str, task: &str, chat: &str) -> Result<Vec<Outgoing>> {
    let history = chat_history::load_history(project, task, chat);
    let attachments = history.iter().rev().find_map(|update| match update {
        AcpUpdate::UserMessage {
            attachments,
            sender,
            ..
        } if matches!(sender.as_deref(), None | Some("connect"))
            && attachments
                .iter()
                .any(|block| !matches!(block, ContentBlockData::Text { .. })) =>
        {
            Some(attachments)
        }
        _ => None,
    });
    let Some(attachments) = attachments else {
        return Err(GroveError::invalid_data(
            "The user has not sent any attachments in this conversation",
        ));
    };
    let files: Vec<Outgoing> = attachments.iter().filter_map(from_block).collect();
    if files.is_empty() {
        return Err(GroveError::invalid_data(
            "The user's attachments are no longer available",
        ));
    }
    Ok(files)
}

/// Studio Tasks read their files from `input/`; others keep them per Session.
fn studio_input_dir(project: &str, task: &str) -> Option<PathBuf> {
    let project = workspace::load_project_by_hash(project).ok().flatten()?;
    (project.project_type == workspace::ProjectType::Studio).then(|| {
        workspace::studio_project_dir(&project.path)
            .join("tasks")
            .join(task)
            .join("input")
    })
}

fn store(
    project: &str,
    task: &str,
    chat: &str,
    file: &Outgoing,
) -> Result<chat_attachments::StoredAttachment> {
    match studio_input_dir(project, task) {
        Some(dir) => chat_attachments::store_attachment_bytes_to_dir(
            &dir,
            &file.name,
            Some(&file.mime_type),
            &file.bytes,
        ),
        None => chat_attachments::store_attachment_bytes(
            project,
            task,
            chat,
            &file.name,
            Some(&file.mime_type),
            &file.bytes,
        ),
    }
}

/// Copy files into a Session and build its prompt blocks: images inline when
/// the Agent reads them, everything else as a resource link (every ACP Agent
/// reads those).
pub fn deliver(
    project: &str,
    task: &str,
    chat: &str,
    files: &[Outgoing],
    images_inline: bool,
) -> Result<Vec<ContentBlockData>> {
    files
        .iter()
        .map(|file| {
            let stored = store(project, task, chat, file)?;
            let inline = images_inline
                && INLINE_IMAGE_TYPES.contains(&file.mime_type.as_str())
                && file.bytes.len() <= MAX_INLINE_IMAGE_BYTES;
            Ok(if inline {
                ContentBlockData::Image {
                    data: base64::engine::general_purpose::STANDARD.encode(&file.bytes),
                    mime_type: file.mime_type.clone(),
                    uri: Some(stored.uri),
                    label: Some(stored.name),
                }
            } else {
                ContentBlockData::ResourceLink {
                    uri: stored.uri,
                    name: stored.name.clone(),
                    mime_type: stored.mime_type,
                    size: Some(stored.size),
                    title: Some(stored.name.clone()),
                    description: Some("Forwarded by the user's Buddy".into()),
                    label: Some(stored.name),
                }
            })
        })
        .collect()
}

/// Store files for a Task that has no Session yet; returns their paths.
pub fn store_for_task(project: &str, task: &str, files: &[Outgoing]) -> Result<Vec<PathBuf>> {
    let dir = match studio_input_dir(project, task) {
        Some(dir) => dir,
        None => crate::storage::grove_dir()
            .join("projects")
            .join(project)
            .join("tasks")
            .join(task)
            .join("attachments"),
    };
    files
        .iter()
        .map(|file| {
            let stored = chat_attachments::store_attachment_bytes_to_dir(
                &dir,
                &file.name,
                Some(&file.mime_type),
                &file.bytes,
            )?;
            file_path(&stored.uri).ok_or_else(|| GroveError::storage("Invalid attachment path"))
        })
        .collect()
}

/// Media in an ACP v2 message, in Grove's block shape (text is left out).
pub fn from_v2_block(
    block: &agent_client_protocol::schema::v2::ContentBlock,
) -> Option<ContentBlockData> {
    let value = serde_json::to_value(block).ok()?;
    let field = |key: &str| value.get(key).and_then(|v| v.as_str()).map(str::to_owned);
    match field("type")?.as_str() {
        "image" => Some(ContentBlockData::Image {
            data: field("data").unwrap_or_default(),
            mime_type: field("mimeType")?,
            uri: field("uri"),
            label: None,
        }),
        "resource_link" => Some(ContentBlockData::ResourceLink {
            uri: field("uri")?,
            name: field("name").unwrap_or_else(|| "resource".into()),
            mime_type: field("mimeType"),
            size: value.get("size").and_then(|v| v.as_i64()),
            title: field("title"),
            description: field("description"),
            label: None,
        }),
        _ => None,
    }
}

/// A file in a Session's history, as `read_session` reports it.
#[derive(Debug, Clone, serde::Serialize)]
pub struct Media {
    pub name: String,
    pub mime_type: String,
    /// Absent when the file is gone (e.g. a link to a deleted file).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    /// Inline image data, returned to the Agent as an image.
    #[serde(skip)]
    pub image: Option<String>,
}

/// Give a history block a path. Inline media is written once into the
/// Session's attachments, named by its content so repeated reads reuse it.
pub fn materialize(
    project: &str,
    task: &str,
    chat: &str,
    block: &ContentBlockData,
) -> Option<Media> {
    let inline = |data: &str, mime_type: &str, uri: Option<&str>, label: Option<&str>| {
        let existing = uri.and_then(file_path).filter(|path| path.is_file());
        let path = existing.or_else(|| {
            let bytes = decode(data).filter(|bytes| !bytes.is_empty())?;
            let digest = Sha256::digest(&bytes);
            let hash: String = digest[..6].iter().map(|b| format!("{b:02x}")).collect();
            let name = format!("media-{hash}.{}", extension(mime_type));
            let dir = studio_input_dir(project, task).unwrap_or_else(|| {
                crate::storage::grove_dir()
                    .join("projects")
                    .join(project)
                    .join("tasks")
                    .join(task)
                    .join("chats")
                    .join(chat)
                    .join("attachments")
            });
            let path = dir.join(&name);
            if !path.is_file() {
                std::fs::create_dir_all(&dir).ok()?;
                std::fs::write(&path, &bytes).ok()?;
            }
            Some(path)
        });
        let name = label
            .map(str::to_owned)
            .or_else(|| path.as_deref().map(file_name))
            .unwrap_or_else(|| format!("media.{}", extension(mime_type)));
        (name, path)
    };
    match block {
        ContentBlockData::Image {
            data,
            mime_type,
            uri,
            label,
        } => {
            let (name, path) = inline(data, mime_type, uri.as_deref(), label.as_deref());
            Some(Media {
                name,
                mime_type: mime_type.clone(),
                path: path.map(|p| p.display().to_string()),
                image: (!data.is_empty()).then(|| data.clone()),
            })
        }
        ContentBlockData::Audio {
            data,
            mime_type,
            label,
        } => {
            let (name, path) = inline(data, mime_type, None, label.as_deref());
            Some(Media {
                name,
                mime_type: mime_type.clone(),
                path: path.map(|p| p.display().to_string()),
                image: None,
            })
        }
        ContentBlockData::ResourceLink {
            uri,
            name,
            mime_type,
            ..
        } => {
            let path = file_path(uri).filter(|path| path.is_file());
            Some(Media {
                name: name.clone(),
                mime_type: mime_type
                    .clone()
                    .or_else(|| path.as_deref().map(guess_mime))
                    .unwrap_or_else(|| "application/octet-stream".into()),
                path: path.map(|p| p.display().to_string()),
                image: None,
            })
        }
        ContentBlockData::Resource { uri, mime_type, .. } => Some(Media {
            name: uri.rsplit('/').next().unwrap_or("resource").to_owned(),
            mime_type: mime_type
                .clone()
                .unwrap_or_else(|| "application/octet-stream".into()),
            path: file_path(uri)
                .filter(|path| path.is_file())
                .map(|p| p.display().to_string()),
            image: None,
        }),
        ContentBlockData::Text { .. } => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::{buddies::test_support::Store, database};

    fn user(sender: Option<&str>, attachments: Vec<ContentBlockData>) -> AcpUpdate {
        AcpUpdate::UserMessage {
            message_id: None,
            text: "look".into(),
            client_message_id: None,
            attachments,
            sender: sender.map(str::to_owned),
            terminal: false,
        }
    }

    #[test]
    fn forwards_the_users_latest_attachments_not_injected_ones() {
        let _lock = database::test_lock().blocking_lock();
        let _store = Store::new();
        let shot = ContentBlockData::Image {
            data: "c2hvdA==".into(),
            mime_type: "image/png".into(),
            uri: None,
            label: Some("shot.png".into()),
        };
        let doc = std::env::temp_dir().join(format!("grove-buddy-{}.txt", uuid::Uuid::new_v4()));
        std::fs::write(&doc, "notes").unwrap();
        let link = ContentBlockData::ResourceLink {
            uri: url::Url::from_file_path(&doc).unwrap().to_string(),
            name: "notes.txt".into(),
            mime_type: None,
            size: None,
            title: None,
            description: None,
            label: None,
        };
        assert!(latest_from_user("p", "t", "c").is_err());
        for event in [
            user(None, vec![shot.clone()]),
            user(Some("connect"), vec![link]),
            user(None, Vec::new()),
            user(Some("automation:daily"), vec![shot]),
        ] {
            chat_history::append_event("p", "t", "c", &event);
        }
        let files = latest_from_user("p", "t", "c").unwrap();
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].name, "notes.txt");
        assert_eq!(files[0].mime_type, "text/plain");
        assert_eq!(files[0].bytes, b"notes");
        std::fs::remove_file(doc).unwrap();
    }

    #[test]
    fn delivers_images_inline_only_when_the_agent_reads_them() {
        let _lock = database::test_lock().blocking_lock();
        let _store = Store::new();
        let files = vec![
            Outgoing {
                name: "shot.png".into(),
                mime_type: "image/png".into(),
                bytes: b"png".to_vec(),
            },
            Outgoing {
                name: "spec.pdf".into(),
                mime_type: "application/pdf".into(),
                bytes: b"pdf".to_vec(),
            },
        ];
        let inline = deliver("p", "t", "c", &files, true).unwrap();
        assert!(matches!(
            &inline[0],
            ContentBlockData::Image { uri: Some(_), .. }
        ));
        assert!(matches!(&inline[1], ContentBlockData::ResourceLink { .. }));
        let linked = deliver("p", "t", "c", &files, false).unwrap();
        let ContentBlockData::ResourceLink { uri, .. } = &linked[0] else {
            panic!("image should be a link for a text-only Agent");
        };
        assert_eq!(std::fs::read(file_path(uri).unwrap()).unwrap(), b"png");
    }

    #[test]
    fn paths_must_be_absolute_existing_files() {
        assert!(from_paths(&["notes.txt".into()]).is_err());
        assert!(from_paths(&["/definitely/missing/file".into()]).is_err());
        assert!(from_paths(&[std::env::temp_dir().display().to_string()]).is_err());
    }
}

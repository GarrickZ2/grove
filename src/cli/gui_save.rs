//! Desktop downloads: pick a path, stream bytes into it from the webview, then
//! let the page open or reveal what it saved.
//!
//! The webview only names a file it got from `save_stream_begin` in this run.
//! It can never write to, open or reveal an arbitrary local path.

use once_cell::sync::Lazy;
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::ipc::{InvokeBody, Request};

struct OpenSave {
    file: File,
    path: PathBuf,
}

static OPEN_SAVES: Lazy<Mutex<HashMap<String, OpenSave>>> = Lazy::new(Mutex::default);
static SAVED_PATHS: Lazy<Mutex<HashSet<PathBuf>>> = Lazy::new(Mutex::default);

const SAVE_ID_HEADER: &str = "x-grove-save-id";

#[derive(Serialize)]
pub struct SaveTarget {
    id: String,
    path: String,
}

fn begin(path: PathBuf) -> Result<SaveTarget, String> {
    let file = File::create(&path).map_err(|e| e.to_string())?;
    let id = uuid::Uuid::new_v4().to_string();
    let target = SaveTarget {
        id: id.clone(),
        path: path.display().to_string(),
    };
    OPEN_SAVES
        .lock()
        .unwrap()
        .insert(id, OpenSave { file, path });
    Ok(target)
}

fn write_chunk(id: &str, bytes: &[u8]) -> Result<(), String> {
    let mut saves = OPEN_SAVES.lock().unwrap();
    let save = saves.get_mut(id).ok_or("Unknown save")?;
    save.file.write_all(bytes).map_err(|e| e.to_string())
}

fn end(id: &str, commit: bool) -> Result<(), String> {
    let save = OPEN_SAVES
        .lock()
        .unwrap()
        .remove(id)
        .ok_or("Unknown save")?;
    drop(save.file);
    if commit {
        SAVED_PATHS.lock().unwrap().insert(save.path);
        Ok(())
    } else {
        std::fs::remove_file(&save.path).map_err(|e| e.to_string())
    }
}

/// Canonical comparison isn't needed: paths come back exactly as issued.
fn saved(path: &str) -> Result<PathBuf, String> {
    let path = Path::new(path).to_path_buf();
    if SAVED_PATHS.lock().unwrap().contains(&path) {
        Ok(path)
    } else {
        Err("Grove did not save this file".into())
    }
}

/// Ask where to save. `None` when the user cancelled the dialog.
#[tauri::command]
pub async fn save_stream_begin(suggested_name: String) -> Result<Option<SaveTarget>, String> {
    let handle = rfd::AsyncFileDialog::new()
        .set_file_name(&suggested_name)
        .save_file()
        .await;
    handle
        .map(|file| begin(file.path().to_path_buf()))
        .transpose()
}

/// Append one chunk, sent as the raw request body so no JSON array of numbers
/// crosses the bridge.
#[tauri::command(async)]
pub fn save_stream_chunk(request: Request<'_>) -> Result<(), String> {
    let id = request
        .headers()
        .get(SAVE_ID_HEADER)
        .and_then(|value| value.to_str().ok())
        .ok_or("Missing save id")?;
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("Expected raw bytes".into());
    };
    write_chunk(id, bytes)
}

/// Finish a save. Without `commit` the partial file is deleted.
#[tauri::command]
pub fn save_stream_end(id: String, commit: bool) -> Result<(), String> {
    end(&id, commit)
}

#[tauri::command]
pub fn open_saved_file(path: String) -> Result<(), String> {
    crate::api::handlers::studio_common::open_in_file_manager(&saved(&path)?);
    Ok(())
}

#[tauri::command]
pub fn reveal_saved_file(path: String) -> Result<(), String> {
    crate::api::handlers::studio_common::reveal_in_file_manager(&saved(&path)?)
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_committed_saves_can_be_opened() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("out.bin");
        let target = begin(path.clone()).unwrap();
        write_chunk(&target.id, b"ab").unwrap();
        write_chunk(&target.id, b"c").unwrap();
        assert!(saved(&target.path).is_err(), "still being written");

        end(&target.id, true).unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"abc");
        assert_eq!(saved(&target.path).unwrap(), path);
        assert!(saved("/etc/passwd").is_err());
        assert!(write_chunk(&target.id, b"d").is_err(), "closed");
    }

    #[test]
    fn an_abandoned_save_leaves_nothing_behind() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("partial.bin");
        let target = begin(path.clone()).unwrap();
        write_chunk(&target.id, b"half").unwrap();
        end(&target.id, false).unwrap();
        assert!(!path.exists());
        assert!(saved(&target.path).is_err());
    }
}

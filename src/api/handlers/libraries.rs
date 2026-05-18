//! Global Excalidraw library REST handlers.
//!
//! Routes (mounted at /api/v1):
//!   GET    /library             load the full library file
//!   PUT    /library             upsert items by id (no implicit deletes)
//!   DELETE /library             reset (wipe entire library)
//!
//! The "Add to Excalidraw" install flow runs entirely on the frontend:
//! browser fetches the `.excalidrawlib` from the URL, parses it, then PUTs
//! the items here — same code path as the SketchCanvas editor sync, so
//! there is one canonical write endpoint instead of two.

use axum::http::StatusCode;
use axum::Json;
use serde::Deserialize;

use crate::error::GroveError;
use crate::storage::libraries::{self, LibraryFile, LibraryItem};

#[derive(Debug, Deserialize)]
pub struct UpsertRequest {
    #[serde(rename = "libraryItems")]
    pub library_items: Vec<LibraryItem>,
}

/// Map a storage-layer `GroveError` onto an HTTP status. Validation-class
/// errors (per-item / total-items / total-bytes caps from `upsert`, JSON
/// parse, bad request data) become 400; everything else (IO, lock, sqlite,
/// unexpected) becomes 500. Internal errors are logged via `eprintln!`
/// for ops; the client never sees the raw message.
fn map_err(context: &str, e: GroveError) -> StatusCode {
    // Validation errors from `libraries::upsert` are tagged with
    // "library_validation"; any other tagged error is still treated as
    // internal so we never accidentally leak storage_tagged business codes
    // out as 400s.
    if e.storage_tag() == Some("library_validation") {
        eprintln!("{context}: validation rejected: {e}");
        return StatusCode::BAD_REQUEST;
    }
    match e {
        GroveError::JsonParse(err) => {
            eprintln!("{context}: bad JSON: {err}");
            StatusCode::BAD_REQUEST
        }
        GroveError::InvalidData(msg) => {
            eprintln!("{context}: invalid data: {msg}");
            StatusCode::BAD_REQUEST
        }
        other => {
            eprintln!("{context}: {other}");
            StatusCode::INTERNAL_SERVER_ERROR
        }
    }
}

/// Run a blocking storage call on the tokio blocking pool so file IO inside
/// a `std::sync::Mutex` doesn't park an async worker. The closure receives
/// nothing because all library state lives in process-global statics.
async fn run_blocking<F, T>(f: F) -> Result<T, StatusCode>
where
    F: FnOnce() -> Result<T, GroveError> + Send + 'static,
    T: Send + 'static,
{
    match tokio::task::spawn_blocking(f).await {
        Ok(Ok(v)) => Ok(v),
        Ok(Err(e)) => Err(map_err("library op", e)),
        Err(join) => {
            eprintln!("library blocking task panicked: {join}");
            Err(StatusCode::INTERNAL_SERVER_ERROR)
        }
    }
}

pub async fn get_library() -> Result<Json<LibraryFile>, StatusCode> {
    run_blocking(libraries::load).await.map(Json)
}

pub async fn put_library(Json(req): Json<UpsertRequest>) -> Result<Json<LibraryFile>, StatusCode> {
    run_blocking(move || libraries::upsert(req.library_items))
        .await
        .map(Json)
}

pub async fn delete_library() -> Result<StatusCode, StatusCode> {
    run_blocking(libraries::reset)
        .await
        .map(|_| StatusCode::NO_CONTENT)
}

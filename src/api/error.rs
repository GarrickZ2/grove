//! Unified API error type for all handlers.
//!
//! Every handler that returns a JSON error body should use `ApiError` instead
//! of defining its own ad-hoc error struct.  This guarantees a consistent
//! `{ "error": "…" }` shape across the entire API surface.
//!
//! Handlers that need richer error variants (e.g. `AcpError`, `TaskTerminalError`)
//! may keep their own `enum` + `impl IntoResponse` — `ApiError` is for the common
//! case.

use axum::http::StatusCode;
use axum::response::IntoResponse;
use serde::Serialize;

// ── Core error type ──────────────────────────────────────────────────────────

/// Unified JSON error body: `{ "error": "<message>" }`.
#[derive(Debug, Serialize)]
#[allow(dead_code)]
pub struct ApiError {
    pub error: String,
}

#[allow(dead_code)]
impl ApiError {
    pub fn bad_request(msg: impl Into<String>) -> (StatusCode, axum::Json<Self>) {
        (
            StatusCode::BAD_REQUEST,
            axum::Json(Self { error: msg.into() }),
        )
    }

    /// Helper: *(404 Not Found, `ApiError`)*
    pub fn not_found(msg: impl Into<String>) -> (StatusCode, axum::Json<Self>) {
        (
            StatusCode::NOT_FOUND,
            axum::Json(Self { error: msg.into() }),
        )
    }

    /// Helper: *(403 Forbidden, `ApiError`)*
    pub fn forbidden(msg: impl Into<String>) -> (StatusCode, axum::Json<Self>) {
        (
            StatusCode::FORBIDDEN,
            axum::Json(Self { error: msg.into() }),
        )
    }

    /// Helper: *(500 Internal Server Error, `ApiError`)*
    pub fn internal(msg: impl Into<String>) -> (StatusCode, axum::Json<Self>) {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            axum::Json(Self { error: msg.into() }),
        )
    }

    /// Helper: *(413 Payload Too Large, `ApiError`)*
    pub fn payload_too_large(msg: impl Into<String>) -> (StatusCode, axum::Json<Self>) {
        (
            StatusCode::PAYLOAD_TOO_LARGE,
            axum::Json(Self { error: msg.into() }),
        )
    }

    /// Helper: *(501 Not Implemented, `ApiError`)*
    pub fn not_implemented(msg: impl Into<String>) -> (StatusCode, axum::Json<Self>) {
        (
            StatusCode::NOT_IMPLEMENTED,
            axum::Json(Self { error: msg.into() }),
        )
    }

    /// Build an error from any status code + message.
    pub fn with_status(
        status: StatusCode,
        msg: impl Into<String>,
    ) -> (StatusCode, axum::Json<Self>) {
        (status, axum::Json(Self { error: msg.into() }))
    }

    /// Convenience for handlers that return `Result<_, StatusCode>` but want to
    /// attach an error body on failure.
    pub fn map_status(err: StatusCode, msg: &str) -> (StatusCode, axum::Json<Self>) {
        (
            err,
            axum::Json(Self {
                error: msg.to_string(),
            }),
        )
    }

    /// Return an `impl IntoResponse` directly — convenient for early returns in
    /// handlers that use `-> impl IntoResponse`.
    pub fn response(status: StatusCode, msg: impl Into<String>) -> axum::response::Response {
        (status, axum::Json(Self { error: msg.into() })).into_response()
    }
}

// Allow `ApiError` to be returned directly from handlers.
impl IntoResponse for ApiError {
    fn into_response(self) -> axum::response::Response {
        (StatusCode::INTERNAL_SERVER_ERROR, axum::Json(self)).into_response()
    }
}

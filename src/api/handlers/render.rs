//! Diagram rendering handlers

use axum::{
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde::{Deserialize, Serialize};
use tokio::process::Command;

#[derive(Deserialize)]
pub struct RenderD2Request {
    pub source: String,
}

#[derive(Serialize)]
pub struct RenderD2Error {
    pub code: String,
    pub message: String,
}

/// POST /api/v1/render/d2
/// Renders D2 source to SVG via the `d2` CLI.
/// Returns 200 + JSON {svg} on success.
/// Returns 422 + JSON {code:"d2_not_installed"} if d2 is not found.
/// Returns 500 + JSON {code:"render_failed", message} on other errors.
pub async fn render_d2(Json(body): Json<RenderD2Request>) -> Response {
    // Write source to a temp file, render to another temp file.
    // Include PID + secs + nanos to avoid collisions under concurrent requests.
    let dur = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    let tmp_id = format!(
        "{}_{}_{}",
        std::process::id(),
        dur.as_secs(),
        dur.subsec_nanos()
    );
    let tmp_dir = std::env::temp_dir();
    let input_path = tmp_dir.join(format!("grove_d2_{}.d2", tmp_id));
    let output_path = tmp_dir.join(format!("grove_d2_{}.svg", tmp_id));

    if let Err(e) = tokio::fs::write(&input_path, body.source.as_bytes()).await {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(RenderD2Error {
                code: "render_failed".to_string(),
                message: format!("Failed to write temp file: {e}"),
            }),
        )
            .into_response();
    }

    let result = Command::new("d2")
        .arg(&input_path)
        .arg(&output_path)
        .output()
        .await;

    // Clean up input temp file
    let _ = tokio::fs::remove_file(&input_path).await;

    match result {
        Ok(out) if out.status.success() => match tokio::fs::read_to_string(&output_path).await {
            Ok(svg) => {
                let _ = tokio::fs::remove_file(&output_path).await;
                (StatusCode::OK, Json(serde_json::json!({ "svg": svg }))).into_response()
            }
            Err(e) => {
                let _ = tokio::fs::remove_file(&output_path).await;
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(RenderD2Error {
                        code: "render_failed".to_string(),
                        message: format!("Failed to read SVG output: {e}"),
                    }),
                )
                    .into_response()
            }
        },
        Ok(out) => {
            let _ = tokio::fs::remove_file(&output_path).await;
            let stderr = String::from_utf8_lossy(&out.stderr).to_string();
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(RenderD2Error {
                    code: "render_failed".to_string(),
                    message: stderr,
                }),
            )
                .into_response()
        }
        Err(e) => {
            let _ = tokio::fs::remove_file(&output_path).await;
            // NotFound means d2 is not installed; other errors are generic spawn failures.
            let (status, code, message) = if e.kind() == std::io::ErrorKind::NotFound {
                (
                    StatusCode::UNPROCESSABLE_ENTITY,
                    "d2_not_installed",
                    format!(
                        "d2 is not installed. Install it with: {}",
                        crate::api::handlers::env::D2_INSTALL_CMD
                    ),
                )
            } else {
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "render_failed",
                    format!("Failed to spawn d2: {e}"),
                )
            };
            (
                status,
                Json(RenderD2Error {
                    code: code.to_string(),
                    message,
                }),
            )
                .into_response()
        }
    }
}

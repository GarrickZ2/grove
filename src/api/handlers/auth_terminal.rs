//! One interactive login process per live local ACP session.

use axum::{
    extract::{Path, Query},
    http::StatusCode,
    response::Response,
};
use portable_pty::CommandBuilder;
use serde::Deserialize;

use super::terminal::{apply_terminal_env_defaults, bridge_pty_terminal};
use crate::{acp, api::device_auth::RevocableWebSocketUpgrade};

#[derive(Deserialize)]
pub struct AuthTerminalQuery {
    cols: Option<u16>,
    rows: Option<u16>,
}

pub async fn ws_handler(
    ws: RevocableWebSocketUpgrade,
    Path((project, task, chat, method)): Path<(String, String, String, String)>,
    Query(query): Query<AuthTerminalQuery>,
) -> Result<Response, (StatusCode, String)> {
    let handle = acp::get_session_handle(&format!("{project}:{task}:{chat}")).ok_or((
        StatusCode::NOT_FOUND,
        "Agent session is no longer connected".into(),
    ))?;
    let attempt = handle
        .begin_terminal_auth(&method)
        .map_err(|message| (StatusCode::BAD_REQUEST, message))?;
    let mut cmd = CommandBuilder::new(&attempt.launch.program);
    cmd.args(&attempt.launch.args);
    cmd.cwd(&attempt.launch.cwd);
    apply_terminal_env_defaults(&mut cmd);
    for (key, value) in &attempt.launch.env {
        cmd.env(key, value);
    }
    Ok(ws.on_upgrade(move |socket| async move {
        let mut shutdown = attempt.shutdown();
        let result = tokio::select! {
            result = bridge_pty_terminal(socket, cmd, query.cols.unwrap_or(80).clamp(20, 500), query.rows.unwrap_or(24).clamp(5, 200), None, true) => result,
            _ = shutdown.wait_for(|shutdown| *shutdown) => Err("Agent session closed during sign-in".into()),
        };
        attempt.finish(result);
    }))
}

//! Web API module for Grove

pub mod handlers;
mod state;

pub use state::{init_file_watchers, shutdown_file_watchers};

use axum::{
    body::Body,
    http::{header, Response, StatusCode, Uri},
    response::IntoResponse,
    routing::{delete, get, patch, post},
    Router,
};
use rust_embed::Embed;
use std::path::PathBuf;
use tower_http::{
    cors::{Any, CorsLayer},
    services::{ServeDir, ServeFile},
};

/// Embedded frontend assets (built from grove-web/dist)
#[derive(Embed)]
#[folder = "grove-web/dist"]
struct FrontendAssets;

/// Create the API router
pub fn create_api_router() -> Router {
    Router::new()
        // Version API
        .route("/version", get(handlers::version::get_version))
        // Config API
        .route("/config", get(handlers::config::get_config))
        .route("/config", patch(handlers::config::patch_config))
        .route(
            "/config/applications",
            get(handlers::config::list_applications),
        )
        .route(
            "/config/applications/icon",
            get(handlers::config::get_app_icon),
        )
        // Environment API
        .route("/env/check", get(handlers::env::check_all))
        .route("/env/check/{name}", get(handlers::env::check_one))
        // Terminal WebSocket
        .route("/terminal", get(handlers::terminal::ws_handler))
        // Task Terminal WebSocket (tmux session)
        .route(
            "/projects/{id}/tasks/{taskId}/terminal",
            get(handlers::terminal::task_terminal_handler),
        )
        // Projects API
        .route("/projects", get(handlers::projects::list_projects))
        .route("/projects", post(handlers::projects::add_project))
        .route("/projects/{id}", get(handlers::projects::get_project))
        .route("/projects/{id}", delete(handlers::projects::delete_project))
        .route("/projects/{id}/stats", get(handlers::projects::get_stats))
        .route(
            "/projects/{id}/branches",
            get(handlers::projects::get_branches),
        )
        // Open IDE/Terminal API
        .route(
            "/projects/{id}/open-ide",
            post(handlers::projects::open_ide),
        )
        .route(
            "/projects/{id}/open-terminal",
            post(handlers::projects::open_terminal),
        )
        // Tasks API
        .route(
            "/projects/{id}/tasks",
            get(handlers::tasks::list_tasks).post(handlers::tasks::create_task),
        )
        .route(
            "/projects/{id}/tasks/{taskId}",
            get(handlers::tasks::get_task),
        )
        .route(
            "/projects/{id}/tasks/{taskId}",
            delete(handlers::tasks::delete_task),
        )
        .route(
            "/projects/{id}/tasks/{taskId}/archive",
            post(handlers::tasks::archive_task),
        )
        .route(
            "/projects/{id}/tasks/{taskId}/recover",
            post(handlers::tasks::recover_task),
        )
        // Notes API
        .route(
            "/projects/{id}/tasks/{taskId}/notes",
            get(handlers::tasks::get_notes).put(handlers::tasks::update_notes),
        )
        // Git operations API
        .route(
            "/projects/{id}/tasks/{taskId}/sync",
            post(handlers::tasks::sync_task),
        )
        .route(
            "/projects/{id}/tasks/{taskId}/commit",
            post(handlers::tasks::commit_task),
        )
        .route(
            "/projects/{id}/tasks/{taskId}/merge",
            post(handlers::tasks::merge_task),
        )
        .route(
            "/projects/{id}/tasks/{taskId}/reset",
            post(handlers::tasks::reset_task),
        )
        .route(
            "/projects/{id}/tasks/{taskId}/rebase-to",
            post(handlers::tasks::rebase_to_task),
        )
        // Task Files API
        .route(
            "/projects/{id}/tasks/{taskId}/files",
            get(handlers::tasks::list_files),
        )
        .route(
            "/projects/{id}/tasks/{taskId}/file",
            get(handlers::tasks::get_file).put(handlers::tasks::update_file),
        )
        // Task Stats API
        .route(
            "/projects/{id}/tasks/{taskId}/stats",
            get(handlers::stats::get_task_stats),
        )
        // Diff/Changes API
        .route(
            "/projects/{id}/tasks/{taskId}/diff",
            get(handlers::tasks::get_diff),
        )
        .route(
            "/projects/{id}/tasks/{taskId}/commits",
            get(handlers::tasks::get_commits),
        )
        // Review Comments API
        .route(
            "/projects/{id}/tasks/{taskId}/review",
            get(handlers::tasks::get_review_comments).post(handlers::tasks::reply_review_comment),
        )
        // Difit (Code Review Server) API
        .route(
            "/projects/{id}/tasks/{taskId}/difit",
            get(handlers::difit::get_difit_status)
                .post(handlers::difit::start_difit)
                .delete(handlers::difit::stop_difit),
        )
        // Hooks API
        .route("/hooks", get(handlers::hooks::list_all_hooks))
        .route(
            "/projects/{id}/hooks/{taskId}",
            delete(handlers::hooks::dismiss_hook),
        )
        // Project Git API
        .route("/projects/{id}/git/status", get(handlers::git::get_status))
        .route(
            "/projects/{id}/git/branches",
            get(handlers::git::get_branches).post(handlers::git::create_branch),
        )
        .route(
            "/projects/{id}/git/branches/{name}",
            delete(handlers::git::delete_branch),
        )
        .route(
            "/projects/{id}/git/branches/{name}/rename",
            post(handlers::git::rename_branch),
        )
        .route(
            "/projects/{id}/git/commits",
            get(handlers::git::get_commits),
        )
        .route("/projects/{id}/git/checkout", post(handlers::git::checkout))
        .route("/projects/{id}/git/pull", post(handlers::git::pull))
        .route("/projects/{id}/git/push", post(handlers::git::push))
        .route("/projects/{id}/git/fetch", post(handlers::git::fetch))
        .route("/projects/{id}/git/stash", post(handlers::git::stash))
}

/// Serve embedded static files
async fn serve_embedded(uri: Uri) -> impl IntoResponse {
    let path = uri.path().trim_start_matches('/');

    // Try to find the file, or fall back to index.html for SPA routing
    let (file, serve_path) = if let Some(content) = FrontendAssets::get(path) {
        (Some(content), path)
    } else if path.is_empty() || !path.contains('.') || path.ends_with(".html") {
        // For SPA: serve index.html for non-asset paths
        (FrontendAssets::get("index.html"), "index.html")
    } else {
        (None, path)
    };

    match file {
        Some(content) => {
            let mime = mime_guess::from_path(serve_path).first_or_octet_stream();
            Response::builder()
                .status(StatusCode::OK)
                .header(header::CONTENT_TYPE, mime.as_ref())
                .body(Body::from(content.data.into_owned()))
                .unwrap()
        }
        None => {
            // Final fallback to index.html
            if let Some(index) = FrontendAssets::get("index.html") {
                Response::builder()
                    .status(StatusCode::OK)
                    .header(header::CONTENT_TYPE, "text/html; charset=utf-8")
                    .body(Body::from(index.data.into_owned()))
                    .unwrap()
            } else {
                Response::builder()
                    .status(StatusCode::NOT_FOUND)
                    .body(Body::from("Not Found"))
                    .unwrap()
            }
        }
    }
}

/// Check if embedded assets are available
pub fn has_embedded_assets() -> bool {
    FrontendAssets::get("index.html").is_some()
}

/// Create the full router with static file serving
pub fn create_router(static_dir: Option<PathBuf>) -> Router {
    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    let api_router = create_api_router();

    let router = Router::new().nest("/api/v1", api_router);

    // Priority: external static_dir > embedded assets
    if let Some(dir) = static_dir {
        let index_file = dir.join("index.html");
        let serve_dir = ServeDir::new(&dir).not_found_service(ServeFile::new(&index_file));
        router.fallback_service(serve_dir).layer(cors)
    } else if has_embedded_assets() {
        // Use embedded assets
        router.fallback(serve_embedded).layer(cors)
    } else {
        router.layer(cors)
    }
}

/// Find the grove-web dist directory
pub fn find_static_dir() -> Option<PathBuf> {
    // Try relative to current executable
    if let Ok(exe_path) = std::env::current_exe() {
        if let Some(exe_dir) = exe_path.parent() {
            // Check for grove-web/dist relative to exe
            let dist_path = exe_dir.join("grove-web").join("dist");
            if dist_path.exists() {
                return Some(dist_path);
            }
            // Check for dist in same directory
            let dist_path = exe_dir.join("dist");
            if dist_path.exists() {
                return Some(dist_path);
            }
        }
    }

    // Try relative to current working directory
    let cwd_dist = PathBuf::from("grove-web/dist");
    if cwd_dist.exists() {
        return Some(cwd_dist);
    }

    // Try relative to project root (for development)
    if let Ok(manifest_dir) = std::env::var("CARGO_MANIFEST_DIR") {
        let project_dist = PathBuf::from(manifest_dir).join("grove-web").join("dist");
        if project_dist.exists() {
            return Some(project_dist);
        }
    }

    None
}

/// Try binding to a port, automatically incrementing if already in use.
/// Tries up to `max_attempts` ports starting from `start_port`.
pub async fn bind_with_fallback(
    start_port: u16,
    max_attempts: u16,
) -> std::io::Result<(tokio::net::TcpListener, u16)> {
    for offset in 0..max_attempts {
        let port = start_port + offset;
        let addr = format!("0.0.0.0:{}", port);
        match tokio::net::TcpListener::bind(&addr).await {
            Ok(listener) => return Ok((listener, port)),
            Err(e) if e.kind() == std::io::ErrorKind::AddrInUse && offset + 1 < max_attempts => {
                eprintln!("Port {} is in use, trying {}...", port, port + 1);
                continue;
            }
            Err(e) => return Err(e),
        }
    }
    unreachable!()
}

/// Start the web server (API + static files)
pub async fn start_server(
    port: u16,
    static_dir: Option<PathBuf>,
    open_browser: bool,
) -> std::io::Result<()> {
    // Initialize FileWatchers for all live tasks
    init_file_watchers();

    let has_ui = static_dir.is_some() || has_embedded_assets();
    let app = create_router(static_dir);

    let (listener, actual_port) = bind_with_fallback(port, 10).await?;

    if has_ui {
        println!("Grove Web UI: http://localhost:{}", actual_port);
    } else {
        println!("Grove API server: http://localhost:{}/api/v1", actual_port);
        println!("(No static files found, API only mode)");
    }

    // Open browser with the actual bound port
    if open_browser && has_ui {
        let url = format!("http://localhost:{}", actual_port);
        tokio::spawn(async move {
            tokio::time::sleep(tokio::time::Duration::from_millis(300)).await;
            println!("Opening browser: {}", url);
            let _ = open::that(&url);
        });
    }

    // Use graceful shutdown to flush FileWatcher data on Ctrl+C
    axum::serve(listener, app)
        .with_graceful_shutdown(async {
            tokio::signal::ctrl_c().await.ok();
            println!("\nShutting down...");
            shutdown_file_watchers();
        })
        .await
        .map_err(std::io::Error::other)
}

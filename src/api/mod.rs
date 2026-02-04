//! Web API module for Grove

pub mod handlers;

use axum::{
    routing::{delete, get, patch, post},
    Router,
};
use std::path::PathBuf;
use tower_http::{
    cors::{Any, CorsLayer},
    services::{ServeDir, ServeFile},
};

/// Create the API router
pub fn create_api_router() -> Router {
    Router::new()
        // Config API
        .route("/config", get(handlers::config::get_config))
        .route("/config", patch(handlers::config::patch_config))
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

/// Create the full router with static file serving
pub fn create_router(static_dir: Option<PathBuf>) -> Router {
    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    let api_router = create_api_router();

    let router = Router::new().nest("/api/v1", api_router);

    // Add static file serving if directory is provided
    if let Some(dir) = static_dir {
        let index_file = dir.join("index.html");
        let serve_dir = ServeDir::new(&dir).not_found_service(ServeFile::new(&index_file));

        router.fallback_service(serve_dir).layer(cors)
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

/// Start the web server (API + static files)
pub async fn start_server(port: u16, static_dir: Option<PathBuf>) -> std::io::Result<()> {
    let app = create_router(static_dir.clone());
    let addr = format!("0.0.0.0:{}", port);

    if static_dir.is_some() {
        println!("Grove Web UI: http://localhost:{}", port);
    } else {
        println!("Grove API server: http://localhost:{}/api/v1", port);
        println!("(No static files found, API only mode)");
    }

    let listener = tokio::net::TcpListener::bind(&addr).await?;
    axum::serve(listener, app)
        .await
        .map_err(std::io::Error::other)
}

//! Web API module for Grove

pub mod auth;
pub mod handlers;
mod state;
pub mod tls;

pub use state::{init_file_watchers, shutdown_file_watchers};

use axum::{
    body::Body,
    http::{header, Response, StatusCode, Uri},
    middleware,
    response::IntoResponse,
    routing::{delete, get, patch, post, put},
    Router,
};
use rust_embed::Embed;
use std::path::PathBuf;
use std::sync::Arc;
use tower_http::{
    cors::{Any, CorsLayer},
    services::{ServeDir, ServeFile},
};

use auth::ServerAuth;

/// Embedded frontend assets (built from grove-web/dist)
#[derive(Embed)]
#[folder = "grove-web/dist"]
struct FrontendAssets;

/// Create the API router
pub fn create_api_router() -> Router {
    Router::new()
        // Version API
        .route("/version", get(handlers::version::get_version))
        // Update check API
        .route("/update-check", get(handlers::update::check_update))
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
        .route("/env/check-commands", post(handlers::env::check_commands))
        // Folder selection API
        .route("/browse-folder", get(handlers::folder::browse_folder))
        // Terminal WebSocket
        .route("/terminal", get(handlers::terminal::ws_handler))
        // Task Terminal WebSocket (tmux session)
        .route(
            "/projects/{id}/tasks/{taskId}/terminal",
            get(handlers::terminal::task_terminal_handler),
        )
        // Chat CRUD
        .route(
            "/projects/{id}/tasks/{taskId}/chats",
            get(handlers::acp::list_chats).post(handlers::acp::create_chat),
        )
        .route(
            "/projects/{id}/tasks/{taskId}/chats/{chatId}",
            patch(handlers::acp::update_chat).delete(handlers::acp::delete_chat),
        )
        // Chat WebSocket (per-chat)
        .route(
            "/projects/{id}/tasks/{taskId}/chats/{chatId}/ws",
            get(handlers::acp::chat_ws_handler),
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
        // File System Operations API
        .route(
            "/projects/{id}/tasks/{taskId}/fs/create-file",
            post(handlers::tasks::create_file),
        )
        .route(
            "/projects/{id}/tasks/{taskId}/fs/create-dir",
            post(handlers::tasks::create_directory),
        )
        .route(
            "/projects/{id}/tasks/{taskId}/fs/delete",
            delete(handlers::tasks::delete_path),
        )
        .route(
            "/projects/{id}/tasks/{taskId}/fs/copy",
            post(handlers::tasks::copy_file),
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
        .route(
            "/projects/{id}/tasks/{taskId}/review/comments",
            post(handlers::tasks::create_review_comment),
        )
        .route(
            "/projects/{id}/tasks/{taskId}/review/comments/{commentId}",
            delete(handlers::tasks::delete_review_comment),
        )
        .route(
            "/projects/{id}/tasks/{taskId}/review/comments/{commentId}/status",
            put(handlers::tasks::update_review_comment_status),
        )
        .route(
            "/projects/{id}/tasks/{taskId}/review/comments/{commentId}/content",
            put(handlers::tasks::edit_review_comment),
        )
        .route(
            "/projects/{id}/tasks/{taskId}/review/comments/{commentId}/replies/{replyId}",
            put(handlers::tasks::edit_review_reply).delete(handlers::tasks::delete_review_reply),
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
        .route(
            "/projects/{id}/git/remotes",
            get(handlers::git::get_remotes),
        )
        .route("/projects/{id}/git/checkout", post(handlers::git::checkout))
        .route("/projects/{id}/git/pull", post(handlers::git::pull))
        .route("/projects/{id}/git/push", post(handlers::git::push))
        .route("/projects/{id}/git/fetch", post(handlers::git::fetch))
        .route("/projects/{id}/git/stash", post(handlers::git::stash))
        .route("/projects/{id}/git/commit", post(handlers::git::commit))
        // Skills API — Agents
        .route(
            "/skills/agents",
            get(handlers::skills::list_agents).post(handlers::skills::add_agent),
        )
        .route(
            "/skills/agents/{id}",
            put(handlers::skills::update_agent).delete(handlers::skills::delete_agent),
        )
        .route(
            "/skills/agents/{id}/toggle",
            post(handlers::skills::toggle_agent),
        )
        // Skills API — Sources
        .route(
            "/skills/sources",
            get(handlers::skills::list_sources).post(handlers::skills::add_source),
        )
        .route(
            "/skills/sources/sync-all",
            post(handlers::skills::sync_all_sources),
        )
        .route(
            "/skills/sources/check-updates",
            post(handlers::skills::check_updates),
        )
        .route(
            "/skills/sources/{name}",
            put(handlers::skills::update_source).delete(handlers::skills::delete_source),
        )
        .route(
            "/skills/sources/{name}/sync",
            post(handlers::skills::sync_source),
        )
        // Skills API — Explore & Install
        .route("/skills/explore", get(handlers::skills::explore_skills))
        .route(
            "/skills/explore/{source}/{skill}",
            get(handlers::skills::get_skill_detail),
        )
        .route("/skills/installed", get(handlers::skills::list_installed))
        .route("/skills/install", post(handlers::skills::install_skill))
        .route(
            "/skills/installed/{repo_key}/{*repo_path}",
            delete(handlers::skills::uninstall_skill),
        )
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

/// Create the full router with static file serving and optional auth
pub fn create_router(static_dir: Option<PathBuf>, auth: Arc<ServerAuth>) -> Router {
    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    let api_router = create_api_router();

    // Auth endpoints are NOT protected by middleware
    let auth_router = Router::new()
        .route("/auth/info", get(auth::auth_info))
        .route("/auth/verify", post(auth::auth_verify))
        .with_state(auth.clone());

    // Protected API routes with auth middleware
    let protected_api = api_router.layer(middleware::from_fn_with_state(
        auth.clone(),
        auth::auth_middleware,
    ));

    let router = Router::new()
        .nest("/api/v1", protected_api)
        .nest("/api/v1", auth_router);

    // Priority: external static_dir > embedded assets
    // Static files are NOT auth-protected (SPA needs to load to show login page)
    if let Some(dir) = static_dir {
        let index_file = dir.join("index.html");
        let serve_dir = ServeDir::new(&dir).not_found_service(ServeFile::new(&index_file));
        router.fallback_service(serve_dir).layer(cors)
    } else if has_embedded_assets() {
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
    host: &str,
    start_port: u16,
    max_attempts: u16,
) -> std::io::Result<(tokio::net::TcpListener, u16)> {
    for offset in 0..max_attempts {
        let port = start_port + offset;
        let addr = format!("{}:{}", host, port);
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

/// Get the first non-loopback IPv4 LAN address (for QR code URL).
pub fn get_lan_ip() -> Option<String> {
    let output = std::process::Command::new("ifconfig")
        .output()
        .or_else(|_| {
            std::process::Command::new("ip")
                .args(["addr", "show"])
                .output()
        })
        .ok()?;
    let text = String::from_utf8_lossy(&output.stdout);
    for line in text.lines() {
        let line = line.trim();
        // macOS: "inet 192.168.x.x netmask ..."
        // Linux: "inet 192.168.x.x/24 ..."
        if let Some(rest) = line.strip_prefix("inet ") {
            let addr = rest.split_whitespace().next().unwrap_or("");
            let addr = addr.split('/').next().unwrap_or(addr);
            if !addr.starts_with("127.") && !addr.is_empty() {
                // Validate it looks like an IPv4
                if addr.split('.').count() == 4 {
                    return Some(addr.to_string());
                }
            }
        }
    }
    None
}

/// Print a QR code to the terminal using Unicode block characters.
fn print_qr_code(content: &str) {
    use qrcode::QrCode;

    let code = match QrCode::new(content) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("Failed to generate QR code: {}", e);
            return;
        }
    };

    let modules = code.to_colors();
    let width = code.width();

    // Use Unicode block characters for compact rendering
    // Each character represents 2 vertical pixels
    // Upper half: \u{2580}, Lower half: \u{2584}, Full: \u{2588}, Empty: space
    let quiet_zone = 2;

    // Top quiet zone
    for _ in 0..quiet_zone / 2 {
        println!("   {}", " ".repeat(width + quiet_zone * 2));
    }

    let rows: Vec<&[qrcode::Color]> = modules.chunks(width).collect();
    let mut y = 0;
    while y < rows.len() {
        let mut line = String::from("   ");
        // Left quiet zone
        for _ in 0..quiet_zone {
            line.push(' ');
        }
        for x in 0..width {
            let top = rows[y][x] == qrcode::Color::Dark;
            let bottom = if y + 1 < rows.len() {
                rows[y + 1][x] == qrcode::Color::Dark
            } else {
                false
            };
            match (top, bottom) {
                (true, true) => line.push('\u{2588}'),  // Full block
                (true, false) => line.push('\u{2580}'), // Upper half
                (false, true) => line.push('\u{2584}'), // Lower half
                (false, false) => line.push(' '),       // Empty
            }
        }
        // Right quiet zone
        for _ in 0..quiet_zone {
            line.push(' ');
        }
        println!("{}", line);
        y += 2;
    }
}

/// Determine the display host for URLs and QR codes.
///
/// - If bound to a concrete IP (not `0.0.0.0`), use that directly.
/// - If bound to `0.0.0.0`, prefer the detected LAN IP, else `"localhost"`.
fn display_host_for(bind_host: &str, lan_ip: Option<&str>) -> String {
    if bind_host != "0.0.0.0" {
        return bind_host.to_string();
    }
    lan_ip
        .map(|s| s.to_string())
        .unwrap_or_else(|| "localhost".to_string())
}

/// Start the web server (API + static files)
pub async fn start_server(
    host: &str,
    port: u16,
    static_dir: Option<PathBuf>,
    open_browser: bool,
    auth: Arc<ServerAuth>,
    tls_mode: crate::cli::web::TlsMode,
) -> std::io::Result<()> {
    // Initialize FileWatchers for all live tasks
    init_file_watchers();

    // Pre-build Grove.app notification bundle (macOS only, first run compiles Swift)
    #[cfg(target_os = "macos")]
    crate::hooks::ensure_grove_app();

    let has_ui = static_dir.is_some() || has_embedded_assets();
    let app = create_router(static_dir, auth.clone());

    let is_mobile = auth.secret_key.is_some();

    // ── TLS branch ───────────────────────────────────────────────────────
    if is_mobile && !matches!(tls_mode, crate::cli::web::TlsMode::Off) {
        // Rustls requires an explicit crypto provider
        let _ = rustls::crypto::ring::default_provider().install_default();

        let lan_ip = get_lan_ip();

        let (cert_pem, key_pem, tls_label) = match &tls_mode {
            crate::cli::web::TlsMode::Custom { cert, key } => {
                let c = std::fs::read_to_string(cert)
                    .map_err(|e| std::io::Error::other(format!("failed to read cert: {}", e)))?;
                let k = std::fs::read_to_string(key)
                    .map_err(|e| std::io::Error::other(format!("failed to read key: {}", e)))?;
                (c, k, "custom certificate")
            }
            _ => {
                let (c, k) = tls::ensure_cert(lan_ip.as_deref())?;
                (c, k, "self-signed")
            }
        };

        let tls_config = axum_server::tls_rustls::RustlsConfig::from_pem(
            cert_pem.into_bytes(),
            key_pem.into_bytes(),
        )
        .await
        .map_err(std::io::Error::other)?;

        let bind_addr: std::net::SocketAddr = format!("{}:{}", host, port)
            .parse()
            .map_err(|e| std::io::Error::other(format!("invalid bind address: {}", e)))?;

        let display_host = display_host_for(host, lan_ip.as_deref());
        let base_url = format!("https://{}:{}", display_host, port);
        let sk = auth.secret_key.as_deref().unwrap_or("");

        println!();
        println!("Grove Mobile UI: {}", base_url);
        println!();
        println!("  Authentication: HMAC-SHA256");
        println!("  TLS: enabled ({})", tls_label);
        println!("  Secret Key: {}", sk);
        println!();

        let qr_url = format!("{}/#sk={}", base_url, sk);
        println!("  Scan to connect:");
        print_qr_code(&qr_url);
        println!();

        axum_server::bind_rustls(bind_addr, tls_config)
            .serve(app.into_make_service())
            .await
            .map_err(std::io::Error::other)?;

        shutdown_file_watchers();
        return Ok(());
    }

    // ── Non-TLS branch ───────────────────────────────────────────────────
    let (listener, actual_port) = bind_with_fallback(host, port, 10).await?;

    if is_mobile {
        // Mobile mode: show LAN URL + HMAC info + QR code
        let lan_ip = get_lan_ip();
        let display_host = display_host_for(host, lan_ip.as_deref());
        let base_url = format!("http://{}:{}", display_host, actual_port);
        let sk = auth.secret_key.as_deref().unwrap_or("");

        println!();
        println!("Grove Mobile UI: {}", base_url);
        println!();
        println!("  Authentication: HMAC-SHA256");
        println!("  Secret Key: {}", sk);
        println!();

        // QR code with SK embedded in URL hash fragment
        let qr_url = format!("{}/#sk={}", base_url, sk);
        println!("  Scan to connect:");
        print_qr_code(&qr_url);
        println!();
    } else if has_ui {
        println!("Grove Web UI: http://localhost:{}", actual_port);
    } else {
        println!("Grove API server: http://localhost:{}/api/v1", actual_port);
        println!("(No static files found, API only mode)");
    }

    // Open browser (only for non-mobile modes; mobile uses QR code)
    if open_browser && has_ui && !is_mobile {
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

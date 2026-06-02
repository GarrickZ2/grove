//! Web API module for Grove

pub mod auth;
pub mod csrf;
pub mod error;
pub mod handlers;
#[cfg(feature = "perf-monitor")]
pub mod perf_middleware;
#[cfg(feature = "perf-monitor")]
pub mod perf_tracing;
pub mod radio_server;
pub mod state;
pub mod tls;

pub use state::{init_file_watchers, shutdown_file_watchers};

use axum::{
    body::Body,
    extract::{DefaultBodyLimit, Request, State},
    http::{header, Response, StatusCode, Uri},
    middleware::{self, Next},
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
pub(crate) struct FrontendAssets;

/// Create the API router
pub fn create_api_router() -> Router {
    let v1 = Router::new()
        // Version API
        .route("/version", get(handlers::version::get_version))
        // Agent usage quota API (Claude Code / Codex / Gemini)
        .route(
            "/agent-usage/{agent}",
            get(handlers::agent_usage::get_agent_usage),
        )
        // Update check API
        .route("/update-check", get(handlers::update::check_update))
        // In-app update API (AppBundle mode)
        .route(
            "/app-update/start",
            post(handlers::update::start_app_update),
        )
        .route(
            "/app-update/progress",
            get(handlers::update::get_app_update_progress),
        )
        .route(
            "/app-update/install",
            post(handlers::update::install_app_update),
        )
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
        // Agent discovery API
        .route("/agents/base", get(handlers::agents::list_base_agents))
        // Custom Agent (Persona) API
        .route(
            "/custom-agents",
            get(handlers::custom_agent::list).post(handlers::custom_agent::create),
        )
        .route(
            "/custom-agents/{id}",
            patch(handlers::custom_agent::update).delete(handlers::custom_agent::delete),
        )
        // User keymap (Command System)
        .route(
            "/keymap",
            get(handlers::keymap::list).delete(handlers::keymap::reset_all),
        )
        .route("/keymap/override", put(handlers::keymap::set_override))
        .route("/keymap/overrides", put(handlers::keymap::set_overrides))
        .route(
            "/keymap/override/{id}",
            delete(handlers::keymap::remove_override),
        )
        .route("/keymap/disabled", put(handlers::keymap::set_disabled))
        // Environment API
        .route("/env/check", get(handlers::env::check_all))
        .route("/env/check/{name}", get(handlers::env::check_one))
        .route("/env/check-commands", post(handlers::env::check_commands))
        // Global Excalidraw library API (shared across all tasks/sketches).
        // The editor sync path (SketchCanvas `onLibraryChange`) PUTs the
        // full library every time, and a real user library can be many MB
        // (e.g. Google icons alone is ~6MB), so we raise the body limit to
        // 128MB instead of disabling it outright — auth-gated LAN exposure
        // (`grove mobile`) makes "unbounded" PUTs an OOM vector. The
        // `libraries::upsert` path enforces per-item, total-item, and
        // total-byte caps as a second layer of defense.
        .route(
            "/library",
            get(handlers::libraries::get_library)
                .put(handlers::libraries::put_library)
                .delete(handlers::libraries::delete_library)
                .layer(DefaultBodyLimit::max(128 * 1024 * 1024)),
        );

    // Process-level perf metrics (RSS + CPU%) and per-handler timing
    // stats for the perf-build frontend. Only registered when the
    // `perf-monitor` cargo feature is on.
    #[cfg(feature = "perf-monitor")]
    let v1 = v1
        .route("/perf/sysinfo", get(handlers::perf::sysinfo_handler))
        .route(
            "/perf/handler-stats",
            get(handlers::perf::handler_stats_handler),
        )
        .route(
            "/perf/handler-stats/reset",
            post(handlers::perf::handler_stats_reset),
        )
        .route("/perf/traces", get(handlers::perf::list_traces_handler))
        .route(
            "/perf/traces/{trace_id}",
            get(handlers::perf::get_trace_handler),
        );

    let v1 = v1
        // Diagram rendering API
        .route("/render/d2", post(handlers::render::render_d2))
        // URL metadata (used by Add Link dialog)
        .route(
            "/url/metadata",
            post(handlers::url_metadata::fetch_url_metadata),
        )
        // Browser Extension WebSocket integration
        .route("/extension/ws", get(handlers::extension::ws_handler))
        // Browser Extension Query Tabs integration
        .route(
            "/extension/tabs",
            get(handlers::extension::get_extension_tabs),
        )
        // Lightweight connection probe — pure check of EXTENSION_SESSION,
        // doesn't hit the WS bridge. Settings page / install dialog use this
        // for the status badge instead of polling /tabs.
        .route(
            "/extension/status",
            get(handlers::extension::get_extension_status),
        )
        // Browser Extension Proxy Command integration
        .route(
            "/extension/command",
            post(handlers::extension::handle_extension_command),
        )
        // Companion package download (zip of grove-extension/dist)
        .route(
            "/extension/download",
            get(handlers::extension::download_extension),
        )
        // Install companion to user-chosen directory for Chrome Load Unpacked
        .route(
            "/extension/install",
            post(handlers::extension::install_extension_to_disk),
        )
        // Native folder picker for choosing the install location
        .route(
            "/extension/browse-install-folder",
            get(handlers::extension::browse_install_folder),
        )
        // Reveal the install directory in OS file manager
        .route(
            "/extension/reveal-path",
            post(handlers::extension::reveal_install_path),
        )
        // Best-effort launch of chrome://extensions/ for the install wizard
        .route(
            "/extension/open-chrome",
            post(handlers::extension::open_chrome_extensions),
        )
        // Folder selection API
        .route("/browse-folder", get(handlers::folder::browse_folder))
        .route("/folders/list", get(handlers::folder::list_folder))
        // Read file API (for Plan File rendering)
        .route("/read-file", get(handlers::folder::read_file))
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
        .route(
            "/projects/{id}/tasks/{taskId}/chats/{chatId}/attachments",
            post(handlers::acp::upload_chat_attachment),
        )
        // Chat WebSocket (per-chat)
        .route(
            "/projects/{id}/tasks/{taskId}/chats/{chatId}/ws",
            get(handlers::acp::chat_ws_handler),
        )
        // Agent PTY WebSocket (terminal-mode chat: spawn agent CLI under PTY,
        // no ACP). Frontend chooses this endpoint when chat.launch_mode == "terminal".
        .route(
            "/projects/{id}/tasks/{taskId}/chats/{chatId}/agent-pty",
            get(handlers::agent_pty::agent_pty_handler),
        )
        // Agent marketplace — unified view of ACP registry + supplement + probe.
        .route(
            "/agents/marketplace",
            get(handlers::marketplace::list_marketplace),
        )
        .route(
            "/agents/marketplace/refresh",
            post(handlers::marketplace::refresh_registry),
        )
        .route(
            "/agents/marketplace/{id}/install",
            post(handlers::marketplace::install_agent)
                .delete(handlers::marketplace::uninstall_agent),
        )
        .route(
            "/agents/marketplace/{id}",
            patch(handlers::marketplace::patch_agent),
        )
        // Chat History (read-only observation mode)
        .route(
            "/projects/{id}/tasks/{taskId}/chats/{chatId}/history",
            get(handlers::acp::get_chat_history),
        )
        // Take Control (kill remote session owner)
        .route(
            "/projects/{id}/tasks/{taskId}/chats/{chatId}/take-control",
            post(handlers::acp::take_control),
        )
        // Fork chat (ACP session/fork)
        .route(
            "/projects/{id}/tasks/{taskId}/chats/{chatId}/fork",
            post(handlers::acp::fork_chat),
        )
        // Projects API
        .route("/projects", get(handlers::projects::list_projects))
        .route("/projects", post(handlers::projects::add_project))
        .route(
            "/projects/new",
            post(handlers::projects::create_new_project),
        )
        .route("/projects/clone", post(handlers::projects::clone_project))
        .route("/projects/{id}", get(handlers::projects::get_project))
        .route("/projects/{id}", patch(handlers::projects::rename_project))
        .route("/projects/{id}", delete(handlers::projects::delete_project))
        .route("/projects/{id}/stats", get(handlers::projects::get_stats))
        // Studio Resource API
        .route(
            "/projects/{id}/resource",
            get(handlers::projects::list_resources).delete(handlers::projects::delete_resource),
        )
        .route(
            "/projects/{id}/resource/upload",
            post(handlers::projects::upload_resource).layer(DefaultBodyLimit::max(
                handlers::studio_common::MAX_UPLOAD_SIZE,
            )),
        )
        .route(
            "/projects/{id}/resource/workdir",
            get(handlers::projects::list_resource_workdirs)
                .post(handlers::projects::add_resource_workdir)
                .delete(handlers::projects::delete_resource_workdir),
        )
        .route(
            "/projects/{id}/resource/workdir/open",
            post(handlers::projects::open_resource_workdir),
        )
        .route(
            "/projects/{id}/resource/preview",
            get(handlers::projects::preview_resource),
        )
        .route(
            "/projects/{id}/resource/download",
            get(handlers::projects::download_resource),
        )
        .route(
            "/projects/{id}/resource/folder",
            post(handlers::projects::create_resource_folder),
        )
        .route(
            "/projects/{id}/resource/move",
            post(handlers::projects::move_resource),
        )
        .route(
            "/projects/{id}/resource/link",
            post(handlers::projects::create_resource_link)
                .patch(handlers::projects::update_resource_link),
        )
        .route(
            "/projects/{id}/instructions",
            get(handlers::projects::get_instructions).put(handlers::projects::update_instructions),
        )
        .route(
            "/projects/{id}/memory",
            get(handlers::projects::get_memory).put(handlers::projects::update_memory),
        )
        .route(
            "/statistics/global",
            get(handlers::statistics::get_global_statistics),
        )
        .route(
            "/statistics/project/{id}",
            get(handlers::statistics::get_project_statistics),
        )
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
        .route(
            "/projects/{id}/init-git",
            post(handlers::projects::init_git),
        )
        // Tasks API
        .route(
            "/projects/{id}/tasks",
            get(handlers::tasks::list_tasks).post(handlers::tasks::create_task),
        )
        .route(
            "/projects/{id}/tasks/{taskId}",
            get(handlers::tasks::get_task).patch(handlers::tasks::rename_task),
        )
        .route(
            "/projects/{id}/tasks/{taskId}",
            delete(handlers::tasks::delete_task),
        )
        .route(
            "/projects/{id}/tasks/{taskId}/activate",
            post(handlers::tasks::activate_task),
        )
        .route(
            "/projects/{id}/tasks/{taskId}/symbols/lookup",
            get(handlers::symbols::lookup_symbol),
        )
        .route(
            "/projects/{id}/tasks/{taskId}/symbols/reindex",
            post(handlers::symbols::reindex_symbols),
        )
        .route(
            "/projects/{id}/tasks/{taskId}/archive",
            post(handlers::tasks::archive_task),
        )
        .route(
            "/projects/{id}/tasks/{taskId}/recover",
            post(handlers::tasks::recover_task),
        )
        .route(
            "/projects/{id}/tasks/{taskId}/graph",
            get(handlers::tasks::get_task_graph),
        )
        .route(
            "/projects/{id}/tasks/{taskId}/graph/spawn",
            post(handlers::tasks::graph_spawn),
        )
        .route(
            "/projects/{id}/tasks/{taskId}/graph/edges",
            post(handlers::tasks::graph_add_edge),
        )
        .route(
            "/projects/{id}/tasks/{taskId}/graph/edges/{edge_id}",
            patch(handlers::tasks::graph_update_edge).delete(handlers::tasks::graph_delete_edge),
        )
        .route(
            "/projects/{id}/tasks/{taskId}/graph/edges/{edge_id}/remind",
            post(handlers::tasks::graph_remind),
        )
        .route(
            "/projects/{id}/tasks/{taskId}/graph/chats/{chat_id}/duty",
            patch(handlers::tasks::graph_update_duty),
        )
        .route(
            "/projects/{id}/tasks/{taskId}/graph/chats/{chat_id}/message",
            post(handlers::tasks::graph_send_message),
        )
        .route(
            "/projects/{id}/tasks/{taskId}/graph/chats/{chat_id}/mention-candidates",
            get(handlers::tasks::mention_candidates),
        )
        // Notes API
        .route(
            "/projects/{id}/tasks/{taskId}/notes",
            get(handlers::tasks::get_notes).put(handlers::tasks::update_notes),
        )
        // Sketches API
        .route(
            "/projects/{id}/tasks/{taskId}/sketches",
            get(handlers::tasks::list_sketches).post(handlers::tasks::create_sketch),
        )
        .route(
            "/projects/{id}/tasks/{taskId}/sketches/{sketchId}",
            get(handlers::tasks::get_scene)
                .put(handlers::tasks::put_scene)
                .patch(handlers::tasks::patch_scene)
                .delete(handlers::tasks::delete_sketch)
                // Dense sketches (hundreds of elements, image fills via
                // `files`) can exceed Axum's default 2 MB body cap; raise
                // it for this route. `DefaultBodyLimit` is only evaluated
                // when a handler extracts the request body, so GET/DELETE
                // (no body extractor) are unaffected — the limit is in
                // effect a PUT/PATCH-only policy even though the layer sits
                // on the full MethodRouter.
                .layer(DefaultBodyLimit::max(8 * 1024 * 1024)),
        )
        .route(
            "/projects/{id}/tasks/{taskId}/sketches/{sketchId}/rename",
            post(handlers::tasks::rename_sketch),
        )
        .route(
            "/projects/{id}/tasks/{taskId}/sketches/{sketchId}/thumbnail",
            post(handlers::tasks::upload_sketch_thumbnail)
                .layer(DefaultBodyLimit::max(4 * 1024 * 1024))
                .get(handlers::tasks::get_sketch_thumbnail),
        )
        .route(
            "/projects/{id}/tasks/{taskId}/sketches/{sketchId}/history",
            get(handlers::tasks::list_sketch_history),
        )
        .route(
            "/projects/{id}/tasks/{taskId}/sketches/{sketchId}/restore",
            post(handlers::tasks::restore_sketch_checkpoint),
        )
        .route(
            "/projects/{id}/tasks/{taskId}/sketches/ws",
            get(handlers::tasks::sketch_ws::ws_handler),
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
        .route(
            "/projects/{id}/tasks/{taskId}/file/raw",
            get(handlers::tasks::get_file_raw),
        )
        .route(
            "/projects/{id}/tasks/{taskId}/dir-entries",
            get(handlers::tasks::dir_entries),
        )
        // Studio Artifacts API
        .route(
            "/projects/{id}/tasks/{taskId}/artifacts",
            get(handlers::tasks::list_artifacts).delete(handlers::tasks::delete_artifact),
        )
        .route(
            "/projects/{id}/tasks/{taskId}/artifacts/preview",
            get(handlers::tasks::preview_artifact),
        )
        .route(
            "/projects/{id}/tasks/{taskId}/artifacts/download",
            get(handlers::tasks::download_artifact),
        )
        .route(
            "/projects/{id}/tasks/{taskId}/artifacts/upload",
            post(handlers::tasks::upload_artifact).layer(DefaultBodyLimit::max(
                handlers::studio_common::MAX_UPLOAD_SIZE,
            )),
        )
        .route(
            "/projects/{id}/tasks/{taskId}/artifacts/workdir",
            get(handlers::tasks::list_artifact_workdirs)
                .post(handlers::tasks::add_artifact_workdir)
                .delete(handlers::tasks::delete_artifact_workdir),
        )
        .route(
            "/projects/{id}/tasks/{taskId}/artifacts/workdir/open",
            post(handlers::tasks::open_artifact_workdir),
        )
        .route(
            "/projects/{id}/tasks/{taskId}/artifacts/sync-to-resource",
            post(handlers::tasks::sync_artifact_to_resource),
        )
        .route(
            "/projects/{id}/tasks/{taskId}/artifacts/link",
            post(handlers::tasks::create_artifact_link)
                .patch(handlers::tasks::update_artifact_link),
        )
        .route(
            "/projects/{id}/tasks/{taskId}/open-folder",
            post(handlers::tasks::open_folder),
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
        .route(
            "/projects/{id}/tasks/{taskId}/fs/move",
            post(handlers::tasks::move_file),
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
            "/projects/{id}/tasks/{taskId}/diff/file",
            get(handlers::tasks::get_single_file_diff),
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
        .route(
            "/projects/{id}/tasks/{taskId}/review/bulk-delete",
            post(handlers::tasks::bulk_delete_review_comments),
        )
        // Hooks API
        .route("/hooks", get(handlers::hooks::list_all_hooks))
        .route("/hooks/preview", post(handlers::hooks::preview_sound))
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
        // AI Settings API — Providers
        .route(
            "/ai/providers",
            get(handlers::ai::list_providers).post(handlers::ai::create_provider),
        )
        .route(
            "/ai/providers/{id}",
            put(handlers::ai::update_provider).delete(handlers::ai::delete_provider),
        )
        .route(
            "/ai/providers/{id}/verify",
            post(handlers::ai::verify_provider),
        )
        // AI Settings API — Audio
        .route("/ai/transcribe", post(handlers::ai::transcribe))
        .route(
            "/ai/audio",
            get(handlers::ai::get_audio).put(handlers::ai::save_audio_global),
        )
        .route(
            "/projects/{id}/ai/audio",
            put(handlers::ai::save_audio_project),
        )
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
            "/skills/sources/auto-sync",
            post(handlers::skills::auto_sync_sources),
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
        .route(
            "/skills/sources/{name}/rename",
            post(handlers::skills::rename_source),
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
        .route(
            "/skills/local/{source}/{*repo_path}",
            delete(handlers::skills::delete_local_skill),
        )
        // TaskGroup API
        .route(
            "/taskgroups",
            get(handlers::taskgroups::list_groups).post(handlers::taskgroups::create_group),
        )
        .route(
            "/taskgroups/{id}",
            patch(handlers::taskgroups::update_group).delete(handlers::taskgroups::delete_group),
        )
        .route(
            "/taskgroups/{id}/slots",
            post(handlers::taskgroups::upsert_slot).put(handlers::taskgroups::set_slots),
        )
        .route(
            "/taskgroups/{id}/slots/{position}",
            delete(handlers::taskgroups::remove_slot),
        )
        // Automations API
        .route(
            "/projects/{id}/automations",
            get(handlers::automations::list).post(handlers::automations::create),
        )
        .route(
            "/projects/{id}/automations/{aid}",
            get(handlers::automations::get)
                .put(handlers::automations::update)
                .delete(handlers::automations::delete),
        )
        .route(
            "/projects/{id}/automations/{aid}/trigger",
            post(handlers::automations::trigger),
        )
        .route(
            "/projects/{id}/automations/{aid}/runs",
            get(handlers::automations::list_runs),
        )
        .route(
            "/projects/{id}/automations/{aid}/runs/{run_id}/cancel",
            post(handlers::automations::cancel_run),
        )
        // Walkie-Talkie / Radio
        .route(
            "/radio/connect-info",
            get(handlers::walkie_talkie::connect_info),
        )
        .route("/radio/start", post(handlers::walkie_talkie::start_radio))
        .route("/radio/stop", post(handlers::walkie_talkie::stop_radio))
        .route("/radio/status", get(handlers::walkie_talkie::radio_status))
        .route(
            "/walkie-talkie/ws",
            get(handlers::walkie_talkie::ws_handler),
        )
        .route(
            "/radio/events/ws",
            get(handlers::walkie_talkie::radio_events_ws_handler),
        );

    #[cfg(feature = "perf-monitor")]
    let v1 = v1.layer(middleware::from_fn(perf_middleware::perf_timing_middleware));

    v1
}

/// Cache-Control header value for an embedded asset, or None for the default.
///
/// Service workers must revalidate on every request so updates propagate
/// within one navigation; everything else (Vite content-hashed assets,
/// index.html served as SPA fallback) uses the browser's default heuristics.
fn cache_control_for(path: &str) -> Option<&'static str> {
    if path == "sw.js" {
        Some("no-cache")
    } else {
        None
    }
}

/// Axum middleware that applies the `cache_control_for` policy to responses.
///
/// Attached to the static-asset fallback on both code paths of `create_router`
/// (the `ServeDir` debug branch AND the `serve_embedded` release branch), so
/// the policy lives in exactly one place — `cache_control_for` — and both
/// serving paths route through it. Because `.layer()` wraps the entire router,
/// this runs on every request; the explicit policy check no-ops for any path
/// `cache_control_for` returns `None` for, so the cost on non-matching
/// requests is one string compare.
async fn sw_cache_control_middleware(request: Request, next: Next) -> impl IntoResponse {
    // axum exposes the URI's absolute path; cache_control_for expects the
    // path trimmed of its leading slash (matches the form serve_embedded
    // uses internally), so trim here for a single source of truth.
    let path = request.uri().path().trim_start_matches('/').to_string();
    let mut response = next.run(request).await;
    if let Some(cc) = cache_control_for(&path) {
        response.headers_mut().insert(
            header::CACHE_CONTROL,
            cc.parse().expect("static header value parses"),
        );
    }
    response
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
            // Cache-Control is applied by sw_cache_control_middleware on
            // both router branches, so no inline header injection here.
            Response::builder()
                .status(StatusCode::OK)
                .header(header::CONTENT_TYPE, mime.as_ref())
                .body(Body::from(content.data.into_owned()))
                .expect("build static file HTTP response")
        }
        None => {
            // Final fallback to index.html
            if let Some(index) = FrontendAssets::get("index.html") {
                Response::builder()
                    .status(StatusCode::OK)
                    .header(header::CONTENT_TYPE, "text/html; charset=utf-8")
                    .body(Body::from(index.data.into_owned()))
                    .expect("build index.html HTTP response")
            } else {
                Response::builder()
                    .status(StatusCode::NOT_FOUND)
                    .body(Body::from("Not Found"))
                    .expect("build 404 HTTP response")
            }
        }
    }
}

/// Check if embedded assets are available
pub fn has_embedded_assets() -> bool {
    FrontendAssets::get("index.html").is_some()
}

/// Create the full router with static file serving and optional auth
pub fn create_router(
    static_dir: Option<PathBuf>,
    auth: Arc<ServerAuth>,
    remote_url: Option<String>,
) -> Router {
    // Unconditionally install the default CryptoProvider for Rustls
    // so that tokio-tungstenite TLS handshakes in proxy mode work flawlessly
    let _ = rustls::crypto::ring::default_provider().install_default();

    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    let api_router = if let Some(remote) = remote_url {
        create_proxy_router(remote)
    } else {
        let api_router = create_api_router();

        // Auth endpoints are NOT protected by middleware
        let auth_router = Router::new()
            .route("/auth/info", get(auth::auth_info))
            .route("/auth/verify", post(auth::auth_verify))
            .with_state(auth.clone());

        // Protected API routes get the HMAC auth layer.
        let protected_api = api_router.layer(middleware::from_fn_with_state(
            auth.clone(),
            auth::auth_middleware,
        ));

        // CSRF guard wraps EVERYTHING under /api/v1 — including auth_router, so
        // /auth/verify can't be probed cross-origin. Sec-Fetch-Site / Origin /
        // Referer are checked for non-safe methods; safe methods (GET/HEAD/OPTIONS,
        // including WebSocket upgrades and CORS preflight) pass through.
        let base = Router::new()
            .nest("/api/v1", protected_api)
            .nest("/api/v1", auth_router)
            .layer(middleware::from_fn(csrf::csrf_middleware));

        // GUI-only loopback endpoints: only registered in gui builds (server binds
        // 127.0.0.1 there). Non-gui builds (web, mobile) simply don't expose these routes.
        #[cfg(feature = "gui")]
        let base = {
            let gui_router = Router::new()
                .route(
                    "/gui/open-task",
                    post(handlers::hooks::handle_gui_open_task),
                )
                .route(
                    "/gui/resolve-permission",
                    post(handlers::hooks::handle_gui_resolve_permission),
                );
            base.nest("/api/v1", gui_router)
        };

        base
    };

    // Priority: external static_dir > embedded assets
    // Static files are NOT auth-protected (SPA needs to load to show login page)
    if let Some(dir) = static_dir {
        let index_file = dir.join("index.html");
        let serve_dir = ServeDir::new(&dir).not_found_service(ServeFile::new(&index_file));
        api_router
            .fallback_service(serve_dir)
            .layer(middleware::from_fn(sw_cache_control_middleware))
            .layer(cors)
    } else if has_embedded_assets() {
        api_router
            .fallback(serve_embedded)
            .layer(middleware::from_fn(sw_cache_control_middleware))
            .layer(cors)
    } else {
        api_router.layer(cors)
    }
}

/// Create a router that proxies all WebSocket and HTTP requests to the remote server.
pub fn create_proxy_router(remote: String) -> Router {
    use axum::routing::any;
    let remote_arc = Arc::new(remote);

    Router::new()
        // Map all known WebSocket routes
        .route("/ws", any(ws_proxy_handler))
        .route("/api/v1/terminal", any(ws_proxy_handler))
        .route("/api/v1/extension/ws", any(ws_proxy_handler))
        .route("/api/v1/walkie-talkie/ws", any(ws_proxy_handler))
        .route("/api/v1/radio/events/ws", any(ws_proxy_handler))
        .route(
            "/api/v1/projects/{id}/tasks/{taskId}/terminal",
            any(ws_proxy_handler),
        )
        .route(
            "/api/v1/projects/{id}/tasks/{taskId}/chats/{chatId}/ws",
            any(ws_proxy_handler),
        )
        .route(
            "/api/v1/projects/{id}/tasks/{taskId}/chats/{chatId}/agent-pty",
            any(ws_proxy_handler),
        )
        .route(
            "/api/v1/projects/{id}/tasks/{taskId}/sketches/ws",
            any(ws_proxy_handler),
        )
        // Map all other HTTP requests
        .route("/api/v1/{*path}", any(http_proxy_handler))
        .with_state(remote_arc)
}

/// Handler specifically for proxying WebSockets.
async fn ws_proxy_handler(
    State(remote_url): State<Arc<String>>,
    ws: axum::extract::ws::WebSocketUpgrade,
    req: axum::extract::Request,
) -> axum::response::Response {
    let path_and_query = req
        .uri()
        .path_and_query()
        .map(|pq| pq.as_str())
        .unwrap_or("");
    let remote_target = format!("{}{}", remote_url.trim_end_matches('/'), path_and_query);
    let headers = req.headers().clone();
    handle_websocket_proxy(ws, remote_target, headers).await
}

/// Handler for proxying normal HTTP requests.
async fn http_proxy_handler(
    State(remote_url): State<Arc<String>>,
    req: axum::extract::Request,
) -> axum::response::Response {
    use axum::http::StatusCode;
    use axum::response::IntoResponse;

    let path_and_query = req
        .uri()
        .path_and_query()
        .map(|pq| pq.as_str().to_string())
        .unwrap_or_default();
    let remote_target = format!("{}{}", remote_url.trim_end_matches('/'), path_and_query);

    let method = req.method().clone();
    let headers = req.headers().clone();
    let body = req.into_body();

    let client = reqwest::Client::builder()
        .danger_accept_invalid_certs(true)
        .build()
        .unwrap_or_else(|_| reqwest::Client::new());

    let mut builder = client.request(method.clone(), &remote_target);

    // Only attach body if the method expects one. Standard proxy gateways (Nginx, Cloudflare)
    // will return 400 Bad Request if we send a chunked/empty body stream on GET/HEAD.
    if method == axum::http::Method::POST
        || method == axum::http::Method::PUT
        || method == axum::http::Method::PATCH
        || method == axum::http::Method::DELETE
    {
        let reqwest_body = reqwest::Body::wrap_stream(body.into_data_stream());
        builder = builder.body(reqwest_body);
    }

    // Copy original headers (except Host, Sec-WebSocket-*, Origin, Referer, and Sec-Fetch-Site which might interfere)
    for (key, value) in headers.iter() {
        let key_str = key.as_str();
        if !key_str.eq_ignore_ascii_case("host")
            && !key_str.starts_with("sec-websocket-")
            && !key_str.eq_ignore_ascii_case("origin")
            && !key_str.eq_ignore_ascii_case("referer")
            && !key_str.eq_ignore_ascii_case("sec-fetch-site")
        {
            builder = builder.header(key.clone(), value.clone());
        }
    }

    // Rewrite Origin, Referer, and Sec-Fetch-Site to match the remote host to bypass CSRF guards
    if let Ok(parsed_url) = url::Url::parse(&remote_target) {
        if let Some(host) = parsed_url.host_str() {
            let scheme = parsed_url.scheme();
            let port_str = parsed_url
                .port()
                .map(|p| format!(":{}", p))
                .unwrap_or_default();
            let remote_origin = format!("{}://{}{}", scheme, host, port_str);
            builder = builder.header("origin", &remote_origin);
            builder = builder.header("referer", format!("{}/", remote_origin));
            builder = builder.header("sec-fetch-site", "same-origin");
        }
    }

    match builder.send().await {
        Ok(resp) => {
            let status = resp.status();
            let resp_headers = resp.headers().clone();

            // Convert reqwest body to axum body
            let body = axum::body::Body::from_stream(resp.bytes_stream());

            let mut axum_resp = axum::response::Response::new(body);
            *axum_resp.status_mut() = status;
            *axum_resp.headers_mut() = resp_headers;
            axum_resp
        }
        Err(e) => {
            eprintln!("Proxy HTTP error to {}: {}", remote_target, e);
            (StatusCode::BAD_GATEWAY, format!("Proxy error: {}", e)).into_response()
        }
    }
}

/// Upgrades the client connection and proxies WebSocket frames bi-directionally to the remote server.
async fn handle_websocket_proxy(
    ws_upgrade: axum::extract::ws::WebSocketUpgrade,
    remote_target: String,
    headers: axum::http::HeaderMap,
) -> axum::response::Response {
    use futures::SinkExt;
    use futures::StreamExt;

    // Convert http(s) to ws(s) URL
    let ws_url = if remote_target.starts_with("https://") {
        remote_target.replacen("https://", "wss://", 1)
    } else if remote_target.starts_with("http://") {
        remote_target.replacen("http://", "ws://", 1)
    } else {
        remote_target
    };

    ws_upgrade.on_upgrade(move |client_ws| async move {
        use tokio_tungstenite::tungstenite::client::IntoClientRequest;
        let mut request = match ws_url.as_str().into_client_request() {
            Ok(r) => r,
            Err(e) => {
                eprintln!("Failed to build WebSocket request for {}: {}", ws_url, e);
                return;
            }
        };

        // Copy relevant headers for authentication
        if let Some(auth) = headers.get("authorization") {
            request.headers_mut().insert("authorization", auth.clone());
        }
        if let Some(cookie) = headers.get("cookie") {
            request.headers_mut().insert("cookie", cookie.clone());
        }
        if let Some(sec_ws_protocol) = headers.get("sec-websocket-protocol") {
            request
                .headers_mut()
                .insert("sec-websocket-protocol", sec_ws_protocol.clone());
        }

        let remote_conn = match tokio_tungstenite::connect_async(request).await {
            Ok((ws_stream, _)) => ws_stream,
            Err(e) => {
                eprintln!("Failed to connect to remote WebSocket {}: {}", ws_url, e);
                return;
            }
        };

        // Bi-directionally copy messages
        let (mut client_write, mut client_read) = client_ws.split();
        let (mut remote_write, mut remote_read) = remote_conn.split();

        let client_to_remote = async {
            while let Some(msg) = client_read.next().await {
                match msg {
                    Ok(m) => {
                        let mapped = match m {
                            axum::extract::ws::Message::Text(t) => {
                                tokio_tungstenite::tungstenite::Message::Text(t.as_str().into())
                            }
                            axum::extract::ws::Message::Binary(b) => {
                                tokio_tungstenite::tungstenite::Message::Binary(b)
                            }
                            axum::extract::ws::Message::Ping(p) => {
                                tokio_tungstenite::tungstenite::Message::Ping(p)
                            }
                            axum::extract::ws::Message::Pong(p) => {
                                tokio_tungstenite::tungstenite::Message::Pong(p)
                            }
                            axum::extract::ws::Message::Close(_) => {
                                tokio_tungstenite::tungstenite::Message::Close(None)
                            }
                        };
                        if let Err(e) = remote_write.send(mapped).await {
                            eprintln!("Error sending to remote WS: {}", e);
                            break;
                        }
                    }
                    Err(e) => {
                        eprintln!("Error reading from client WS: {}", e);
                        break;
                    }
                }
            }
        };

        let remote_to_client = async {
            while let Some(msg) = remote_read.next().await {
                match msg {
                    Ok(m) => {
                        let mapped = match m {
                            tokio_tungstenite::tungstenite::Message::Text(t) => {
                                axum::extract::ws::Message::Text(
                                    axum::extract::ws::Utf8Bytes::from(t.as_str()),
                                )
                            }
                            tokio_tungstenite::tungstenite::Message::Binary(b) => {
                                axum::extract::ws::Message::Binary(b)
                            }
                            tokio_tungstenite::tungstenite::Message::Ping(p) => {
                                axum::extract::ws::Message::Ping(p)
                            }
                            tokio_tungstenite::tungstenite::Message::Pong(p) => {
                                axum::extract::ws::Message::Pong(p)
                            }
                            tokio_tungstenite::tungstenite::Message::Close(_) => {
                                axum::extract::ws::Message::Close(None)
                            }
                            tokio_tungstenite::tungstenite::Message::Frame(_) => continue,
                        };
                        if let Err(e) = client_write.send(mapped).await {
                            eprintln!("Error sending to client WS: {}", e);
                            break;
                        }
                    }
                    Err(e) => {
                        eprintln!("Error reading from remote WS: {}", e);
                        break;
                    }
                }
            }
        };

        tokio::select! {
            _ = client_to_remote => {}
            _ = remote_to_client => {}
        }
    })
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
    // Auto-correct agent defaults based on what's actually installed on PATH.
    // Runs every server start because the user's environment can change between
    // sessions (e.g. they install a new CLI).
    crate::acp::init_agent_defaults();

    // Recover any installed_agents row stuck in `installing` — happens when
    // grove was killed mid-download. Marking them failed lets the user
    // retry from Marketplace instead of staring at a perpetual spinner.
    if let Err(e) = crate::storage::installed_agents::recover_orphaned_installing() {
        eprintln!(
            "[startup] failed to recover orphaned installing rows: {}",
            e
        );
    }

    // Long-running ACP registry refresher. First tick happens immediately
    // so the cache gets populated on startup (Marketplace then opens fast
    // with full data). Subsequent ticks run every hour and call
    // refresh_if_stale, which respects the 24h freshness window — so we
    // hit the CDN at most once per stale-window in steady state, but stay
    // responsive when grove runs for days/weeks.
    tokio::spawn(async {
        let mut ticker = tokio::time::interval(std::time::Duration::from_secs(60 * 60));
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            ticker.tick().await;
            crate::storage::agent_registry::refresh_if_stale().await;
        }
    });

    // Automation cron scheduler — fires while Grove is running. Missed runs
    // during downtime are not back-filled; the next fire window is the next
    // scheduled tick.
    //
    // Sweep any `queued` runs left over from a previous Grove process (whose
    // ACP subscriber died with the process) into `interrupted` first, so
    // the run-history UI doesn't display them as "still running forever".
    let sweep_now = chrono::Utc::now().timestamp();
    match crate::storage::automations::sweep_interrupted_runs(sweep_now) {
        Ok(n) if n > 0 => {
            crate::automation::awarn!("swept {n} stale queued run(s) → interrupted");
        }
        Ok(_) => {}
        Err(e) => {
            crate::automation::awarn!("startup sweep failed: {e}");
        }
    }
    crate::automation::scheduler::spawn();

    // Start the in-process agent_graph MCP listener (loopback-only). Failure to
    // bind is non-fatal — the rest of the server still boots; ACP sessions will
    // simply spawn without agent_graph tools available.
    match crate::api::handlers::agent_graph_mcp::start_listener(
        crate::api::handlers::agent_graph_mcp::DEFAULT_BASE_PORT,
        crate::api::handlers::agent_graph_mcp::DEFAULT_MAX_ATTEMPTS,
    )
    .await
    {
        Ok(_port) => {
            // Listener bound successfully; success is silent. Failures still
            // print since they disable agent_graph tools downstream.
        }
        Err(e) => {
            eprintln!(
                "[agent_graph_mcp] failed to bind listener: {} — agent_graph tools disabled",
                e
            );
        }
    }

    // Initialize FileWatchers for all live tasks
    init_file_watchers();

    // Ensure _main and _local system groups exist
    if let Err(e) = crate::storage::taskgroups::ensure_system_groups() {
        eprintln!("[warning] Failed to ensure system groups: {}", e);
    }

    // Pre-build Grove.app notification bundle (macOS only, first run compiles Swift)
    #[cfg(target_os = "macos")]
    crate::hooks::ensure_grove_app();

    let has_ui = static_dir.is_some() || has_embedded_assets();
    let app = create_router(static_dir, auth.clone(), None);

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
        if auth.key_is_generated {
            println!(
                "    (auto-generated; not persisted — type a passkey at the prompt for a stable key)"
            );
        }
        println!();

        let qr_url = format!("{}/#sk={}", base_url, sk);
        println!("  Scan to connect:");
        print_qr_code(&qr_url);
        println!();

        // Set env vars so handlers (e.g. connect_info) can discover port & protocol
        std::env::set_var("GROVE_PORT", port.to_string());
        std::env::set_var("GROVE_PROTOCOL", "https");

        axum_server::bind_rustls(bind_addr, tls_config)
            .serve(app.into_make_service())
            .await
            .map_err(std::io::Error::other)?;

        shutdown_file_watchers();
        return Ok(());
    }

    // ── Non-TLS branch ───────────────────────────────────────────────────
    let (listener, actual_port) = bind_with_fallback(host, port, 10).await?;

    // Set env vars so handlers (e.g. connect_info) can discover port & protocol
    std::env::set_var("GROVE_PORT", actual_port.to_string());
    std::env::set_var("GROVE_PROTOCOL", "http");

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
        if auth.key_is_generated {
            println!(
                "    (auto-generated; not persisted — type a passkey at the prompt for a stable key)"
            );
        }
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

    // Graceful shutdown on Ctrl-C flushes FileWatcher data before exit.
    // A second Ctrl-C short-circuits the graceful wait and force-exits —
    // necessary because axum::serve keeps blocking while in-flight WebSocket
    // connections stay open (e.g. ACP stream, walkie-talkie), and browsers
    // won't close them on their own.
    axum::serve(listener, app)
        .with_graceful_shutdown(async {
            tokio::signal::ctrl_c().await.ok();
            println!("\nShutting down... (press Ctrl-C again to force exit)");
            shutdown_file_watchers();
            tokio::spawn(async {
                tokio::signal::ctrl_c().await.ok();
                eprintln!("Forced exit.");
                // Process::exit skips Drop — flush FileWatcher buffers
                // explicitly so second-Ctrl-C doesn't lose pending writes.
                shutdown_file_watchers();
                std::process::exit(130);
            });
        })
        .await
        .map_err(std::io::Error::other)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cache_control_for_sw_js_is_no_cache() {
        assert_eq!(cache_control_for("sw.js"), Some("no-cache"));
    }

    #[test]
    fn cache_control_for_other_paths_is_none() {
        assert_eq!(cache_control_for("index.html"), None);
        assert_eq!(cache_control_for("assets/main.js"), None);
        assert_eq!(cache_control_for("manifest.json"), None);
        assert_eq!(cache_control_for("icon-512.png"), None);
    }
}

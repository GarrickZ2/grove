//! Config API handlers

use axum::body::Body;
use axum::extract::Query;
use axum::http::{header, StatusCode};
use axum::response::Response;
use axum::Json;
use serde::{Deserialize, Serialize};
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};

use crate::storage::config::{self, Config, CustomAgentServer, CustomLayoutConfig, ThemeConfig};

/// M6: serialize PATCH /api/v1/config 调用，避免并发 PATCH 互相覆盖
/// (load → mutate → save 三段不是原子的)。
static CONFIG_WRITE_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// GET /api/v1/config response
#[derive(Debug, Serialize)]
pub struct ConfigResponse {
    pub theme: ThemeConfigDto,
    pub layout: LayoutConfigDto,
    pub web: WebConfigDto,
    pub auto_link: AutoLinkConfigDto,
    pub acp: AcpConfigDto,
    pub hooks: HooksConfigDto,
    pub notifications: NotificationsConfigDto,
    pub indexing: IndexingConfigDto,
    /// Terminal 模式使用的复用器 ("tmux" | "zellij")
    pub terminal_multiplexer: String,
    /// Server platform identifier ("macos" | "windows" | "linux"). Lets the
    /// frontend gate platform-specific UI (IDE picker, Terminal picker)
    /// without doing a separate `listApplications` round-trip.
    pub platform: &'static str,
}

#[derive(Debug, Serialize)]
pub struct IndexingConfigDto {
    pub enabled: bool,
    pub disabled_languages: Vec<String>,
    /// Read-only list of languages the build understands. Patch ignores
    /// this field — adding/removing comes from the grove binary's
    /// compiled-in `Language` enum.
    pub supported_languages: Vec<SupportedLanguageDto>,
}

#[derive(Debug, Serialize)]
pub struct SupportedLanguageDto {
    pub id: String,
    pub display_name: &'static str,
    pub extensions: Vec<&'static str>,
}

#[derive(Debug, Serialize)]
pub struct NotificationsConfigDto {
    pub tray_enabled: bool,
    pub tray_show_permission: bool,
    pub tray_show_done: bool,
    pub tray_show_running: bool,
    pub notification_enabled: bool,
    pub notification_show_permission: bool,
    pub notification_show_done: bool,
    pub notification_show_running: bool,
    pub menubar_shortcut: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct HooksConfigDto {
    pub response_sound_enabled: bool,
    pub response_sound: String,
    pub permission_sound_enabled: bool,
    pub permission_sound: String,
}

#[derive(Debug, Serialize)]
pub struct ThemeConfigDto {
    pub name: String,
}

#[derive(Debug, Serialize)]
pub struct LayoutConfigDto {
    pub default: String,
    pub agent_command: Option<String>,
    /// JSON string of custom layouts array
    pub custom_layouts: Option<String>,
    /// Selected custom layout ID (when default="custom")
    pub selected_custom_id: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct WebConfigDto {
    pub ide: Option<String>,
    pub terminal: Option<String>,
    pub terminal_mode: Option<String>,
    pub workspace_layout: Option<String>,
    pub show_hide_window_shortcut: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct AutoLinkConfigDto {
    pub patterns: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct AcpConfigDto {
    pub agent_command: Option<String>,
    pub custom_agents: Vec<CustomAgentDto>,
    pub render_window_limit: u32,
    pub render_window_trigger: u32,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct CustomAgentDto {
    pub id: String,
    pub name: String,
    #[serde(rename = "type")]
    pub agent_type: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub args: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auth_header: Option<String>,
}

impl From<&Config> for ConfigResponse {
    fn from(config: &Config) -> Self {
        Self {
            theme: ThemeConfigDto {
                name: config.theme.name.clone(),
            },
            layout: LayoutConfigDto {
                default: config.layout.default.clone(),
                agent_command: config.layout.agent_command.clone(),
                custom_layouts: config.layout.custom.as_ref().map(|c| c.tree.clone()),
                selected_custom_id: config.layout.selected_custom_id.clone(),
            },
            web: WebConfigDto {
                ide: config.web.ide.clone(),
                terminal: config.web.terminal.clone(),
                terminal_mode: config.web.terminal_mode.clone(),
                workspace_layout: config.web.workspace_layout.clone(),
                show_hide_window_shortcut: config.web.show_hide_window_shortcut.clone(),
            },
            auto_link: AutoLinkConfigDto {
                patterns: config.auto_link.patterns.clone(),
            },
            acp: AcpConfigDto {
                agent_command: config.acp.agent_command.clone(),
                custom_agents: config
                    .acp
                    .custom_agents
                    .iter()
                    .map(|a| CustomAgentDto {
                        id: a.id.clone(),
                        name: a.name.clone(),
                        agent_type: a.agent_type.clone(),
                        command: a.command.clone(),
                        args: a.args.clone(),
                        url: a.url.clone(),
                        auth_header: a.auth_header.clone(),
                    })
                    .collect(),
                render_window_limit: config.acp.render_window_limit,
                render_window_trigger: config.acp.render_window_trigger,
            },
            hooks: HooksConfigDto {
                response_sound_enabled: config.hooks.response_sound_enabled,
                response_sound: config.hooks.response_sound.clone(),
                permission_sound_enabled: config.hooks.permission_sound_enabled,
                permission_sound: config.hooks.permission_sound.clone(),
            },
            notifications: NotificationsConfigDto {
                tray_enabled: config.notifications.tray_enabled,
                tray_show_permission: config.notifications.tray_show_permission,
                tray_show_done: config.notifications.tray_show_done,
                tray_show_running: config.notifications.tray_show_running,
                notification_enabled: config.notifications.notification_enabled,
                notification_show_permission: config.notifications.notification_show_permission,
                notification_show_done: config.notifications.notification_show_done,
                notification_show_running: config.notifications.notification_show_running,
                menubar_shortcut: config.notifications.menubar_shortcut.clone(),
            },
            indexing: IndexingConfigDto {
                enabled: config.indexing.enabled,
                disabled_languages: config.indexing.disabled_languages.clone(),
                supported_languages: crate::symbols::Language::all()
                    .iter()
                    .map(|l| SupportedLanguageDto {
                        id: l.as_str().to_string(),
                        display_name: l.display_name(),
                        extensions: l.extensions().to_vec(),
                    })
                    .collect(),
            },
            terminal_multiplexer: config.terminal_multiplexer.to_string(),
            platform: current_platform(),
        }
    }
}

/// PATCH /api/v1/config request
#[derive(Debug, Deserialize)]
pub struct ConfigPatchRequest {
    pub theme: Option<ThemeConfigPatch>,
    pub layout: Option<LayoutConfigPatch>,
    pub web: Option<WebConfigPatch>,
    pub auto_link: Option<AutoLinkConfigPatch>,
    pub acp: Option<AcpConfigPatch>,
    pub hooks: Option<HooksConfigPatch>,
    pub notifications: Option<NotificationsConfigPatch>,
    pub indexing: Option<IndexingConfigPatch>,
    /// Terminal 模式使用的复用器 ("tmux" | "zellij")
    pub terminal_multiplexer: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct IndexingConfigPatch {
    pub enabled: Option<bool>,
    /// Replaces the deny-list wholesale when present.
    pub disabled_languages: Option<Vec<String>>,
}

#[derive(Debug, Deserialize)]
pub struct NotificationsConfigPatch {
    pub tray_enabled: Option<bool>,
    pub tray_show_permission: Option<bool>,
    pub tray_show_done: Option<bool>,
    pub tray_show_running: Option<bool>,
    pub notification_enabled: Option<bool>,
    pub notification_show_permission: Option<bool>,
    pub notification_show_done: Option<bool>,
    pub notification_show_running: Option<bool>,
    /// `Some("")` clears the shortcut, `Some("Cmd+Shift+M")` sets it.
    pub menubar_shortcut: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct HooksConfigPatch {
    pub response_sound_enabled: Option<bool>,
    pub response_sound: Option<String>,
    pub permission_sound_enabled: Option<bool>,
    pub permission_sound: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct AcpConfigPatch {
    pub agent_command: Option<String>,
    pub custom_agents: Option<Vec<CustomAgentDto>>,
    pub render_window_limit: Option<u32>,
    pub render_window_trigger: Option<u32>,
}

#[derive(Debug, Deserialize)]
pub struct ThemeConfigPatch {
    pub name: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct LayoutConfigPatch {
    pub default: Option<String>,
    pub agent_command: Option<String>,
    /// JSON string of custom layouts array
    pub custom_layouts: Option<String>,
    /// Selected custom layout ID (when default="custom")
    pub selected_custom_id: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct WebConfigPatch {
    pub ide: Option<String>,
    pub terminal: Option<String>,
    pub terminal_mode: Option<String>,
    pub workspace_layout: Option<String>,
    pub show_hide_window_shortcut: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct AutoLinkConfigPatch {
    pub patterns: Option<Vec<String>>,
}

/// GET /api/v1/config
pub async fn get_config() -> Json<ConfigResponse> {
    let config = config::load_config();
    Json(ConfigResponse::from(&config))
}

/// PATCH /api/v1/config
pub async fn patch_config(
    Json(patch): Json<ConfigPatchRequest>,
) -> Result<Json<ConfigResponse>, StatusCode> {
    let _guard = CONFIG_WRITE_LOCK.lock().await;
    let mut config = config::load_config();

    // Apply theme patch
    let mut theme_changed = false;
    if let Some(theme_patch) = patch.theme {
        if let Some(name) = theme_patch.name {
            if config.theme.name != name {
                theme_changed = true;
            }
            config.theme = ThemeConfig { name };
        }
    }

    // Apply layout patch
    if let Some(layout_patch) = patch.layout {
        if let Some(default) = layout_patch.default {
            config.layout.default = default;
        }
        if layout_patch.agent_command.is_some() {
            config.layout.agent_command = layout_patch.agent_command;
        }
        if let Some(custom_layouts) = layout_patch.custom_layouts {
            if custom_layouts.is_empty() {
                config.layout.custom = None;
            } else {
                config.layout.custom = Some(CustomLayoutConfig {
                    tree: custom_layouts,
                });
            }
        }
        if layout_patch.selected_custom_id.is_some() {
            config.layout.selected_custom_id = layout_patch.selected_custom_id;
        }
    }

    // Apply terminal_multiplexer patch
    if let Some(mux_str) = patch.terminal_multiplexer {
        if let Ok(mux) = mux_str.parse::<config::TerminalMultiplexer>() {
            config.terminal_multiplexer = mux;
        }
    }

    // Apply web patch
    if let Some(web_patch) = patch.web {
        if web_patch.ide.is_some() {
            config.web.ide = web_patch.ide;
        }
        if web_patch.terminal.is_some() {
            config.web.terminal = web_patch.terminal;
        }
        if web_patch.terminal_mode.is_some() {
            config.web.terminal_mode = web_patch.terminal_mode;
        }
        if web_patch.workspace_layout.is_some() {
            config.web.workspace_layout = web_patch.workspace_layout;
        }
        if let Some(shortcut) = web_patch.show_hide_window_shortcut {
            let shortcut = shortcut.trim().to_string();
            config.web.show_hide_window_shortcut = if shortcut.is_empty() {
                None
            } else {
                Some(shortcut)
            };
        }
    }

    // Apply auto_link patch
    if let Some(auto_link_patch) = patch.auto_link {
        if let Some(patterns) = auto_link_patch.patterns {
            config.auto_link.patterns = patterns;
        }
    }

    // Apply acp patch
    if let Some(acp_patch) = patch.acp {
        if acp_patch.agent_command.is_some() {
            config.acp.agent_command = acp_patch.agent_command;
        }
        if let Some(custom_agents) = acp_patch.custom_agents {
            config.acp.custom_agents = custom_agents
                .into_iter()
                .map(|a| CustomAgentServer {
                    id: a.id,
                    name: a.name,
                    agent_type: a.agent_type,
                    command: a.command,
                    args: a.args,
                    url: a.url,
                    auth_header: a.auth_header,
                })
                .collect();
        }
        if let Some(limit) = acp_patch.render_window_limit {
            config.acp.render_window_limit = limit;
        }
        if let Some(trigger) = acp_patch.render_window_trigger {
            config.acp.render_window_trigger = trigger;
        }
        config.acp.normalize();
    }

    // Apply hooks patch
    if let Some(hooks_patch) = patch.hooks {
        if let Some(response_sound_enabled) = hooks_patch.response_sound_enabled {
            config.hooks.response_sound_enabled = response_sound_enabled;
        }
        if let Some(response_sound) = hooks_patch.response_sound {
            config.hooks.response_sound = response_sound;
        }
        if let Some(permission_sound_enabled) = hooks_patch.permission_sound_enabled {
            config.hooks.permission_sound_enabled = permission_sound_enabled;
        }
        if let Some(permission_sound) = hooks_patch.permission_sound {
            config.hooks.permission_sound = permission_sound;
        }
    }

    // Apply notifications patch
    if let Some(n) = patch.notifications {
        if let Some(v) = n.tray_enabled {
            config.notifications.tray_enabled = v;
        }
        if let Some(v) = n.tray_show_permission {
            config.notifications.tray_show_permission = v;
        }
        if let Some(v) = n.tray_show_done {
            config.notifications.tray_show_done = v;
        }
        if let Some(v) = n.tray_show_running {
            config.notifications.tray_show_running = v;
        }
        if let Some(v) = n.notification_enabled {
            config.notifications.notification_enabled = v;
        }
        if let Some(v) = n.notification_show_permission {
            config.notifications.notification_show_permission = v;
        }
        if let Some(v) = n.notification_show_done {
            config.notifications.notification_show_done = v;
        }
        if let Some(v) = n.notification_show_running {
            config.notifications.notification_show_running = v;
        }
        if let Some(shortcut) = n.menubar_shortcut {
            let shortcut = shortcut.trim().to_string();
            config.notifications.menubar_shortcut = if shortcut.is_empty() {
                None
            } else {
                Some(shortcut)
            };
        }
    }

    // Apply indexing patch
    if let Some(i) = patch.indexing {
        if let Some(v) = i.enabled {
            config.indexing.enabled = v;
        }
        if let Some(langs) = i.disabled_languages {
            // Drop unknown languages so the deny-list doesn't accumulate
            // typos or stale entries from older clients.
            let known: std::collections::HashSet<&'static str> = crate::symbols::Language::all()
                .iter()
                .map(|l| l.as_str())
                .collect();
            config.indexing.disabled_languages = langs
                .into_iter()
                .filter(|l| known.contains(l.as_str()))
                .collect();
        }
    }

    // Save config
    config::save_config(&config).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    // Notify Radio clients if theme changed
    if theme_changed {
        use crate::api::handlers::walkie_talkie::{broadcast_radio_event, RadioEvent};
        broadcast_radio_event(RadioEvent::ThemeChanged);
    }

    Ok(Json(ConfigResponse::from(&config)))
}

/// Application info for picker
#[derive(Debug, Serialize)]
pub struct AppInfo {
    pub name: String,
    pub path: String,
    /// Bundle identifier if available (e.g., "com.microsoft.VSCode")
    pub bundle_id: Option<String>,
}

/// Applications list response
#[derive(Debug, Serialize)]
pub struct ApplicationsResponse {
    pub apps: Vec<AppInfo>,
    /// Platform identifier: "macos", "windows", "linux"
    pub platform: &'static str,
}

/// Current platform identifier
fn current_platform() -> &'static str {
    if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(target_os = "windows") {
        "windows"
    } else {
        "linux"
    }
}

/// GET /api/v1/config/applications
/// List installed applications (for IDE/Terminal picker)
pub async fn list_applications() -> Json<ApplicationsResponse> {
    let platform = current_platform();

    if platform != "macos" {
        return Json(ApplicationsResponse {
            apps: Vec::new(),
            platform,
        });
    }

    // Sync FS work + parallel plist parsing — push off the tokio runtime.
    let apps = tokio::task::spawn_blocking(scan_macos_apps)
        .await
        .unwrap_or_default();

    Json(ApplicationsResponse { apps, platform })
}

fn scan_macos_apps() -> Vec<AppInfo> {
    use rayon::prelude::*;

    let app_dirs = [
        "/Applications",
        "/System/Applications",
        "/System/Applications/Utilities",
    ];
    let home_apps = dirs::home_dir().map(|h| h.join("Applications"));

    let mut entries: Vec<PathBuf> = Vec::new();
    for dir_path in app_dirs
        .iter()
        .map(|s| Path::new(*s))
        .chain(home_apps.iter().map(|p| p.as_path()))
    {
        if let Ok(rd) = std::fs::read_dir(dir_path) {
            for entry in rd.flatten() {
                let path = entry.path();
                if path.extension().is_some_and(|ext| ext == "app") {
                    entries.push(path);
                }
            }
        }
    }

    let mut apps: Vec<AppInfo> = entries
        .par_iter()
        .filter_map(|path| {
            let name = path.file_stem()?.to_str()?.to_string();
            let bundle_id = get_bundle_id(path);
            Some(AppInfo {
                name,
                path: path.to_string_lossy().to_string(),
                bundle_id,
            })
        })
        .collect();

    apps.sort_by_key(|a| a.name.to_lowercase());
    apps.dedup_by(|a, b| a.name == b.name);
    apps
}

/// Try to extract bundle identifier from app's Info.plist
fn get_bundle_id(app_path: &Path) -> Option<String> {
    read_plist_string(&app_path.join("Contents/Info.plist"), "CFBundleIdentifier")
}

/// Read a string-valued key from a plist file (in-process, no subprocess).
/// `plist::Value::from_file` already returns Err for missing files, so we
/// don't gate on `exists()` first — saves one stat per app.
fn read_plist_string(plist_path: &Path, key: &str) -> Option<String> {
    let value = plist::Value::from_file(plist_path).ok()?;
    let s = value.as_dictionary()?.get(key)?.as_string()?.trim();
    if s.is_empty() {
        None
    } else {
        Some(s.to_string())
    }
}

// --- App Icon API ---

/// Query params for icon endpoint
#[derive(Debug, Deserialize)]
pub struct IconQuery {
    pub path: String,
}

/// GET /api/v1/config/applications/icon?path=<app_path>
/// Returns the app icon as a 64×64 PNG image
pub async fn get_app_icon(Query(query): Query<IconQuery>) -> Result<Response<Body>, StatusCode> {
    // Icon extraction relies on macOS-only `defaults` and `sips`. On other
    // platforms there is nothing to return — fail fast instead of spawning
    // missing binaries.
    if current_platform() != "macos" {
        return Err(StatusCode::NOT_FOUND);
    }

    let app_path = Path::new(&query.path);

    // L6: 防路径穿越 — 必须是绝对路径、规范化（无 `..`）、扩展名为 .app。
    // 这条 endpoint 把 path 喂给 sips/defaults 子进程，宽松校验有命令拼接风险。
    if !app_path.is_absolute() {
        return Err(StatusCode::BAD_REQUEST);
    }
    if app_path
        .components()
        .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return Err(StatusCode::BAD_REQUEST);
    }
    if app_path.extension().and_then(|e| e.to_str()) != Some("app") {
        return Err(StatusCode::BAD_REQUEST);
    }
    if !app_path.exists() {
        return Err(StatusCode::NOT_FOUND);
    }

    // Get bundle ID for better cache key
    let bundle_id = get_bundle_id(app_path);

    // Check disk cache first
    let cache_path = get_icon_cache_path(&query.path, bundle_id.as_deref());
    if let Some(png_data) = read_cached_icon(&cache_path, app_path) {
        return Ok(png_response(png_data));
    }

    // Create cache directory
    if let Some(parent) = cache_path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }

    // Extract icon directly to cache path (no temp file needed)
    let png_data = extract_app_icon_to_file(app_path, &cache_path).ok_or(StatusCode::NOT_FOUND)?;

    Ok(png_response(png_data))
}

fn get_icon_cache_path(app_path_str: &str, bundle_id: Option<&str>) -> std::path::PathBuf {
    let cache_dir = crate::storage::grove_dir().join("cache").join("icons");

    // Priority 1: Use bundle ID if available (e.g., "com.apple.calculator.png")
    if let Some(id) = bundle_id {
        let safe_name = id.replace(['/', '\\', ':'], "_");
        return cache_dir.join(format!("{}.png", safe_name));
    }

    // Priority 2: Use app name from path (e.g., "Calculator.png")
    if let Some(app_name) = Path::new(app_path_str).file_stem().and_then(|s| s.to_str()) {
        let safe_name = app_name.replace(['/', '\\', ':', ' '], "_").to_lowercase();
        return cache_dir.join(format!("{}.png", safe_name));
    }

    // Fallback: Use hash of full path (should rarely happen)
    let mut hasher = DefaultHasher::new();
    app_path_str.hash(&mut hasher);
    let hash = hasher.finish();
    cache_dir.join(format!("{:x}.png", hash))
}

fn read_cached_icon(cache_path: &Path, app_path: &Path) -> Option<Vec<u8>> {
    let cache_meta = std::fs::metadata(cache_path).ok()?;
    let plist_path = app_path.join("Contents/Info.plist");
    let plist_meta = std::fs::metadata(&plist_path).ok()?;

    // Cache is valid if it's newer than the plist
    if cache_meta.modified().ok()? >= plist_meta.modified().ok()? {
        let data = std::fs::read(cache_path).ok()?;

        // Validate cached data is a valid PNG (check header and min size)
        if data.len() >= 8 && &data[0..8] == b"\x89PNG\r\n\x1a\n" {
            Some(data)
        } else {
            // Invalid cache, delete it
            let _ = std::fs::remove_file(cache_path);
            None
        }
    } else {
        // Stale cache, delete it
        let _ = std::fs::remove_file(cache_path);
        None
    }
}

fn png_response(data: Vec<u8>) -> Response<Body> {
    // Use shorter cache time (5 minutes) to allow quick updates during development
    // ETag based on content hash for cache validation
    let mut hasher = DefaultHasher::new();
    data.hash(&mut hasher);
    let etag = format!("\"{}\"", hasher.finish());

    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "image/png")
        .header(header::CACHE_CONTROL, "public, max-age=300") // 5 minutes instead of 24 hours
        .header(header::ETAG, etag)
        .body(Body::from(data))
        .expect("build icon PNG response")
}

/// Extract app icon and write directly to the target file path
/// Returns the PNG data if successful
fn extract_app_icon_to_file(app_path: &Path, output_path: &Path) -> Option<Vec<u8>> {
    let resources_dir = app_path.join("Contents/Resources");

    if !resources_dir.exists() {
        return None;
    }

    // Read CFBundleIconFile (or CFBundleIconName) from Info.plist
    let plist_path = app_path.join("Contents/Info.plist");
    let icon_file_name = read_plist_string(&plist_path, "CFBundleIconFile")
        .or_else(|| read_plist_string(&plist_path, "CFBundleIconName"));

    // Try to find the .icns file
    let icns_path = if let Some(icon_name) = icon_file_name {
        // Ensure .icns extension
        let name_with_ext = if icon_name.ends_with(".icns") {
            icon_name.clone()
        } else {
            format!("{}.icns", icon_name)
        };

        let path = resources_dir.join(&name_with_ext);
        if path.exists() {
            Some(path)
        } else {
            // Try without .icns extension
            let alt_path = resources_dir.join(&icon_name);
            if alt_path.exists() {
                Some(alt_path)
            } else {
                None
            }
        }
    } else {
        None
    };

    // If we found an icon from plist, use it
    if let Some(path) = icns_path {
        return convert_icns_to_png(&path, output_path);
    }

    // Fallback: try to find any .icns file in Resources directory
    if let Ok(entries) = std::fs::read_dir(&resources_dir) {
        // First, try common icon names
        let common_names = ["AppIcon.icns", "app.icns", "icon.icns", "application.icns"];

        for name in &common_names {
            let path = resources_dir.join(name);
            if path.exists() {
                if let Some(data) = convert_icns_to_png(&path, output_path) {
                    return Some(data);
                }
            }
        }

        // If common names don't work, find the largest .icns file
        // (usually the main app icon is the largest)
        let mut icns_files: Vec<_> = entries
            .flatten()
            .filter_map(|entry| {
                let path = entry.path();
                if path.extension()?.to_str()? == "icns" {
                    let size = std::fs::metadata(&path).ok()?.len();
                    Some((path, size))
                } else {
                    None
                }
            })
            .collect();

        // Sort by size descending
        icns_files.sort_by_key(|b| std::cmp::Reverse(b.1));

        // Try the largest .icns file
        if let Some((path, _)) = icns_files.first() {
            if let Some(data) = convert_icns_to_png(path, output_path) {
                return Some(data);
            }
        }
    }

    None
}

/// Convert icns to PNG using a temporary file based on output_path
/// Prevents race conditions by using unique temp file per request
fn convert_icns_to_png(icns_path: &Path, output_path: &Path) -> Option<Vec<u8>> {
    if !icns_path.exists() {
        return None;
    }

    // Use output path + timestamp + PID to create unique temp file
    // This ensures no conflicts even with parallel requests for the same app
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("system time before UNIX epoch");
    let temp_path = output_path.with_extension(format!(
        "tmp.{}.{}.{}",
        std::process::id(),
        now.as_secs(),
        now.subsec_nanos()
    ));

    // Convert to temporary file
    let output = std::process::Command::new("sips")
        .args([
            "-s",
            "format",
            "png",
            "--resampleHeightWidth",
            "64",
            "64",
            &icns_path.to_string_lossy(),
            "--out",
            &temp_path.to_string_lossy(),
        ])
        .stderr(std::process::Stdio::null())
        .output()
        .ok()?;

    if !output.status.success() {
        // Try alternative approach: extract without resizing
        let alt_output = std::process::Command::new("sips")
            .args([
                "-s",
                "format",
                "png",
                &icns_path.to_string_lossy(),
                "--out",
                &temp_path.to_string_lossy(),
            ])
            .stderr(std::process::Stdio::null())
            .output()
            .ok()?;

        if !alt_output.status.success() {
            let _ = std::fs::remove_file(&temp_path);
            return None;
        }
    }

    // Read the temporary file
    let data = std::fs::read(&temp_path).ok()?;

    // Validate PNG data (check PNG header)
    if data.len() < 8 || &data[0..8] != b"\x89PNG\r\n\x1a\n" {
        let _ = std::fs::remove_file(&temp_path);
        return None;
    }

    // Atomically move temp file to final location
    // If another thread already created the cache, this will overwrite it (idempotent)
    if std::fs::rename(&temp_path, output_path).is_err() {
        // Rename failed (maybe cross-device), try copy + delete
        let _ = std::fs::copy(&temp_path, output_path);
        let _ = std::fs::remove_file(&temp_path);
    }

    Some(data)
}

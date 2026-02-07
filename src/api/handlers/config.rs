//! Config API handlers

use axum::body::Body;
use axum::extract::Query;
use axum::http::{header, StatusCode};
use axum::response::Response;
use axum::Json;
use serde::{Deserialize, Serialize};
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::path::Path;

use crate::storage::config::{self, Config, CustomLayoutConfig, ThemeConfig};

/// GET /api/v1/config response
#[derive(Debug, Serialize)]
pub struct ConfigResponse {
    pub theme: ThemeConfigDto,
    pub layout: LayoutConfigDto,
    pub web: WebConfigDto,
    pub multiplexer: String,
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
    pub terminal_theme: Option<String>,
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
                terminal_theme: config.web.terminal_theme.clone(),
            },
            multiplexer: config.multiplexer.to_string(),
        }
    }
}

/// PATCH /api/v1/config request
#[derive(Debug, Deserialize)]
pub struct ConfigPatchRequest {
    pub theme: Option<ThemeConfigPatch>,
    pub layout: Option<LayoutConfigPatch>,
    pub web: Option<WebConfigPatch>,
    pub multiplexer: Option<String>,
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
    pub terminal_theme: Option<String>,
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
    let mut config = config::load_config();

    // Apply theme patch
    if let Some(theme_patch) = patch.theme {
        if let Some(name) = theme_patch.name {
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

    // Apply multiplexer patch
    if let Some(mux_str) = patch.multiplexer {
        if let Ok(mux) = mux_str.parse::<config::Multiplexer>() {
            config.multiplexer = mux;
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
        if web_patch.terminal_theme.is_some() {
            config.web.terminal_theme = web_patch.terminal_theme;
        }
    }

    // Save config
    config::save_config(&config).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

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
}

/// GET /api/v1/config/applications
/// List installed applications (for IDE/Terminal picker)
pub async fn list_applications() -> Json<ApplicationsResponse> {
    let mut apps = Vec::new();

    // Scan common application directories
    let app_dirs = [
        "/Applications",
        "/System/Applications",
        "/System/Applications/Utilities",
    ];

    // Also check user's Applications folder
    let home_apps = dirs::home_dir().map(|h| h.join("Applications"));

    for dir_path in app_dirs
        .iter()
        .map(|s| Path::new(*s))
        .chain(home_apps.iter().map(|p| p.as_path()))
    {
        if let Ok(entries) = std::fs::read_dir(dir_path) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.extension().is_some_and(|ext| ext == "app") {
                    if let Some(name) = path.file_stem().and_then(|s| s.to_str()) {
                        // Try to get bundle identifier from Info.plist
                        let bundle_id = get_bundle_id(&path);

                        apps.push(AppInfo {
                            name: name.to_string(),
                            path: path.to_string_lossy().to_string(),
                            bundle_id,
                        });
                    }
                }
            }
        }
    }

    // Sort by name
    apps.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));

    // Remove duplicates (same name from different locations, prefer /Applications)
    apps.dedup_by(|a, b| a.name == b.name);

    Json(ApplicationsResponse { apps })
}

/// Try to extract bundle identifier from app's Info.plist
fn get_bundle_id(app_path: &Path) -> Option<String> {
    let plist_path = app_path.join("Contents/Info.plist");
    get_plist_value(&plist_path, "CFBundleIdentifier")
}

/// Read a single key from a plist file using macOS `defaults` command
fn get_plist_value(plist_path: &Path, key: &str) -> Option<String> {
    if !plist_path.exists() {
        return None;
    }

    let output = std::process::Command::new("defaults")
        .args(["read", &plist_path.to_string_lossy(), key])
        .output()
        .ok()?;

    if output.status.success() {
        let val = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if !val.is_empty() {
            return Some(val);
        }
    }

    None
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
    let app_path = Path::new(&query.path);

    // Validate the path points to a .app bundle
    if !app_path.exists() || app_path.extension().and_then(|e| e.to_str()) != Some("app") {
        return Err(StatusCode::NOT_FOUND);
    }

    // Check disk cache first
    let cache_path = get_icon_cache_path(&query.path);
    if let Some(png_data) = read_cached_icon(&cache_path, app_path) {
        return Ok(png_response(png_data));
    }

    // Extract the icon
    let png_data = extract_app_icon(app_path).ok_or(StatusCode::NOT_FOUND)?;

    // Cache to disk
    if let Some(parent) = cache_path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let _ = std::fs::write(&cache_path, &png_data);

    Ok(png_response(png_data))
}

fn get_icon_cache_path(app_path_str: &str) -> std::path::PathBuf {
    let mut hasher = DefaultHasher::new();
    app_path_str.hash(&mut hasher);
    let hash = hasher.finish();
    crate::storage::grove_dir()
        .join("cache")
        .join("icons")
        .join(format!("{:x}.png", hash))
}

fn read_cached_icon(cache_path: &Path, app_path: &Path) -> Option<Vec<u8>> {
    let cache_meta = std::fs::metadata(cache_path).ok()?;
    let plist_path = app_path.join("Contents/Info.plist");
    let plist_meta = std::fs::metadata(&plist_path).ok()?;

    // Cache is valid if it's newer than the plist
    if cache_meta.modified().ok()? >= plist_meta.modified().ok()? {
        std::fs::read(cache_path).ok()
    } else {
        None
    }
}

fn png_response(data: Vec<u8>) -> Response<Body> {
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "image/png")
        .header(header::CACHE_CONTROL, "public, max-age=86400")
        .body(Body::from(data))
        .unwrap()
}

fn extract_app_icon(app_path: &Path) -> Option<Vec<u8>> {
    // Read CFBundleIconFile (or CFBundleIconName) from Info.plist
    let plist_path = app_path.join("Contents/Info.plist");
    let icon_file_name = get_plist_value(&plist_path, "CFBundleIconFile")
        .or_else(|| get_plist_value(&plist_path, "CFBundleIconName"))?;

    // Ensure .icns extension
    let icon_name = if icon_file_name.ends_with(".icns") {
        icon_file_name
    } else {
        format!("{}.icns", icon_file_name)
    };
    let icns_path = app_path.join("Contents/Resources").join(&icon_name);

    if !icns_path.exists() {
        return None;
    }

    // Convert .icns to 64×64 PNG using macOS built-in `sips`
    let temp_dir = std::env::temp_dir();
    let temp_png = temp_dir.join(format!("grove_icon_{}.png", std::process::id()));

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
            &temp_png.to_string_lossy(),
        ])
        .output()
        .ok()?;

    if !output.status.success() {
        let _ = std::fs::remove_file(&temp_png);
        return None;
    }

    let data = std::fs::read(&temp_png).ok()?;
    let _ = std::fs::remove_file(&temp_png);

    if data.is_empty() {
        None
    } else {
        Some(data)
    }
}

//! Config API handlers

use axum::{http::StatusCode, Json};
use serde::{Deserialize, Serialize};

use crate::storage::config::{self, Config, CustomLayoutConfig, ThemeConfig};

/// GET /api/v1/config response
#[derive(Debug, Serialize)]
pub struct ConfigResponse {
    pub theme: ThemeConfigDto,
    pub layout: LayoutConfigDto,
    pub web: WebConfigDto,
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
            },
        }
    }
}

/// PATCH /api/v1/config request
#[derive(Debug, Deserialize)]
pub struct ConfigPatchRequest {
    pub theme: Option<ThemeConfigPatch>,
    pub layout: Option<LayoutConfigPatch>,
    pub web: Option<WebConfigPatch>,
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

    // Apply web patch
    if let Some(web_patch) = patch.web {
        if web_patch.ide.is_some() {
            config.web.ide = web_patch.ide;
        }
        if web_patch.terminal.is_some() {
            config.web.terminal = web_patch.terminal;
        }
    }

    // Save config
    config::save_config(&config).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    Ok(Json(ConfigResponse::from(&config)))
}

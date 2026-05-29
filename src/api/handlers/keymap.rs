//! User keymap API handlers
//!
//! REST endpoints:
//!   GET    /api/v1/keymap                       → full bundle
//!   PUT    /api/v1/keymap/override              → upsert one override
//!   DELETE /api/v1/keymap/override/{id}         → delete one override
//!   PUT    /api/v1/keymap/disabled              → toggle disabled flag
//!   DELETE /api/v1/keymap                       → reset everything
//!
//! The frontend's `userKeymapStore` calls GET once on startup and
//! PUT/DELETE incrementally as the user edits Settings.

use axum::{extract::Path, http::StatusCode, response::IntoResponse, Json};
use serde::{Deserialize, Serialize};

use crate::storage::keymap::{self, KeymapBundle, KeymapOverride};

#[derive(Debug, Serialize)]
pub struct KeymapBundleDto {
    pub overrides: Vec<KeymapOverride>,
    pub disabled: Vec<String>,
}

impl From<KeymapBundle> for KeymapBundleDto {
    fn from(b: KeymapBundle) -> Self {
        Self {
            overrides: b.overrides,
            disabled: b.disabled,
        }
    }
}

/// GET /api/v1/keymap
pub async fn list() -> impl IntoResponse {
    match keymap::load_bundle() {
        Ok(b) => Ok(Json(KeymapBundleDto::from(b))),
        Err(e) => Err((StatusCode::INTERNAL_SERVER_ERROR, e.to_string())),
    }
}

fn validate_override(o: &KeymapOverride) -> Result<(), (StatusCode, String)> {
    if o.command_id.trim().is_empty() {
        return Err((
            StatusCode::BAD_REQUEST,
            "command_id is required".to_string(),
        ));
    }
    // Empty key is allowed: it means "unbind" (no keyboard shortcut, but
    // the command is still invokable via Palette / UI). The override row
    // shadows the catalog default bindings.
    Ok(())
}

/// PUT /api/v1/keymap/override
pub async fn set_override(Json(body): Json<KeymapOverride>) -> impl IntoResponse {
    validate_override(&body)?;
    match keymap::set_override(&body) {
        Ok(()) => Ok(StatusCode::NO_CONTENT),
        Err(e) => Err((StatusCode::INTERNAL_SERVER_ERROR, e.to_string())),
    }
}

#[derive(Debug, Deserialize)]
pub struct BindingDto {
    pub key: String,
    #[serde(default)]
    pub when_ctx: Option<String>,
    #[serde(default)]
    pub scope: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct SetOverridesBody {
    pub command_id: String,
    pub bindings: Vec<BindingDto>,
}

/// PUT /api/v1/keymap/overrides
///
/// Replace a command's full binding set (multi-binding, VSCode/Zed style).
/// An empty `bindings` array unbinds the command (override row(s) cleared).
pub async fn set_overrides(Json(body): Json<SetOverridesBody>) -> impl IntoResponse {
    if body.command_id.trim().is_empty() {
        return Err((
            StatusCode::BAD_REQUEST,
            "command_id is required".to_string(),
        ));
    }
    let bindings: Vec<KeymapOverride> = body
        .bindings
        .into_iter()
        .map(|b| KeymapOverride {
            command_id: body.command_id.clone(),
            key: b.key,
            when_ctx: b.when_ctx,
            scope: b.scope,
        })
        .collect();
    match keymap::set_overrides(&body.command_id, &bindings) {
        Ok(()) => Ok(StatusCode::NO_CONTENT),
        Err(e) => Err((StatusCode::INTERNAL_SERVER_ERROR, e.to_string())),
    }
}

/// DELETE /api/v1/keymap/override/{id}
///
/// Idempotent: returns 204 whether or not a row existed. "Reset" in the
/// UI maps to "make sure no override exists for this command" — telling
/// the client "404, you can't reset what isn't customised" is unhelpful
/// noise (RFC 9110 permits both shapes; idempotent is the friendlier
/// choice here).
pub async fn remove_override(Path(id): Path<String>) -> impl IntoResponse {
    match keymap::remove_override(&id) {
        Ok(_) => Ok(StatusCode::NO_CONTENT),
        Err(e) => Err((StatusCode::INTERNAL_SERVER_ERROR, e.to_string())),
    }
}

#[derive(Debug, Deserialize)]
pub struct SetDisabledBody {
    pub command_id: String,
    pub disabled: bool,
}

/// PUT /api/v1/keymap/disabled
pub async fn set_disabled(Json(body): Json<SetDisabledBody>) -> impl IntoResponse {
    if body.command_id.trim().is_empty() {
        return Err((
            StatusCode::BAD_REQUEST,
            "command_id is required".to_string(),
        ));
    }
    match keymap::set_disabled(&body.command_id, body.disabled) {
        Ok(()) => Ok(StatusCode::NO_CONTENT),
        Err(e) => Err((StatusCode::INTERNAL_SERVER_ERROR, e.to_string())),
    }
}

/// DELETE /api/v1/keymap
pub async fn reset_all() -> impl IntoResponse {
    match keymap::reset_all() {
        Ok(()) => Ok(StatusCode::NO_CONTENT),
        Err(e) => Err((StatusCode::INTERNAL_SERVER_ERROR, e.to_string())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::response::IntoResponse;

    struct DirGuard {
        temp: std::path::PathBuf,
    }
    impl Drop for DirGuard {
        fn drop(&mut self) {
            crate::storage::set_grove_dir_override(None);
            let _ = std::fs::remove_dir_all(&self.temp);
        }
    }
    fn sandbox_grove_dir() -> DirGuard {
        let temp = std::env::temp_dir().join(format!(
            "grove-keymap-handler-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&temp).unwrap();
        crate::storage::set_grove_dir_override(Some(temp.clone()));
        DirGuard { temp }
    }

    async fn acquire_lock() -> tokio::sync::MutexGuard<'static, ()> {
        crate::storage::database::test_lock().lock().await
    }

    #[tokio::test]
    async fn empty_bundle_on_fresh_db() {
        let _lock = acquire_lock().await;
        let _dir = sandbox_grove_dir();
        let bundle = keymap::load_bundle().unwrap();
        assert!(bundle.overrides.is_empty());
        assert!(bundle.disabled.is_empty());
    }

    #[tokio::test]
    async fn set_then_load_roundtrip() {
        let _lock = acquire_lock().await;
        let _dir = sandbox_grove_dir();

        let o = KeymapOverride {
            command_id: "task.archive".to_string(),
            key: "Mod+Shift+A".to_string(),
            when_ctx: Some("inWorkspace".to_string()),
            scope: None,
        };
        keymap::set_override(&o).unwrap();
        keymap::set_disabled("debug.devtools.open", true).unwrap();

        let bundle = keymap::load_bundle().unwrap();
        assert_eq!(bundle.overrides.len(), 1);
        assert_eq!(bundle.overrides[0].command_id, "task.archive");
        assert_eq!(bundle.overrides[0].key, "Mod+Shift+A");
        assert_eq!(bundle.overrides[0].when_ctx.as_deref(), Some("inWorkspace"));
        assert_eq!(bundle.overrides[0].scope, None);
        assert_eq!(bundle.disabled, vec!["debug.devtools.open".to_string()]);
    }

    #[tokio::test]
    async fn override_replaces_previous() {
        let _lock = acquire_lock().await;
        let _dir = sandbox_grove_dir();

        keymap::set_override(&KeymapOverride {
            command_id: "x".to_string(),
            key: "j".to_string(),
            when_ctx: None,
            scope: None,
        })
        .unwrap();
        keymap::set_override(&KeymapOverride {
            command_id: "x".to_string(),
            key: "k".to_string(),
            when_ctx: None,
            scope: None,
        })
        .unwrap();

        let bundle = keymap::load_bundle().unwrap();
        assert_eq!(bundle.overrides.len(), 1);
        assert_eq!(bundle.overrides[0].key, "k");
    }

    #[tokio::test]
    async fn remove_override_returns_true_when_present() {
        let _lock = acquire_lock().await;
        let _dir = sandbox_grove_dir();

        keymap::set_override(&KeymapOverride {
            command_id: "x".to_string(),
            key: "j".to_string(),
            when_ctx: None,
            scope: None,
        })
        .unwrap();
        assert!(keymap::remove_override("x").unwrap());
        assert!(!keymap::remove_override("x").unwrap()); // already gone
    }

    #[tokio::test]
    async fn set_disabled_idempotent() {
        let _lock = acquire_lock().await;
        let _dir = sandbox_grove_dir();

        keymap::set_disabled("x", true).unwrap();
        keymap::set_disabled("x", true).unwrap(); // idempotent
        keymap::set_disabled("y", true).unwrap();

        let bundle = keymap::load_bundle().unwrap();
        assert_eq!(bundle.disabled.len(), 2);

        keymap::set_disabled("x", false).unwrap();
        let bundle = keymap::load_bundle().unwrap();
        assert_eq!(bundle.disabled, vec!["y".to_string()]);
    }

    #[tokio::test]
    async fn reset_all_clears_everything() {
        let _lock = acquire_lock().await;
        let _dir = sandbox_grove_dir();

        keymap::set_override(&KeymapOverride {
            command_id: "x".to_string(),
            key: "j".to_string(),
            when_ctx: None,
            scope: None,
        })
        .unwrap();
        keymap::set_disabled("y", true).unwrap();

        keymap::reset_all().unwrap();
        let bundle = keymap::load_bundle().unwrap();
        assert!(bundle.overrides.is_empty());
        assert!(bundle.disabled.is_empty());
    }

    #[tokio::test]
    async fn handler_set_override_validates() {
        let _lock = acquire_lock().await;
        let _dir = sandbox_grove_dir();

        let bad = KeymapOverride {
            command_id: "".to_string(),
            key: "j".to_string(),
            when_ctx: None,
            scope: None,
        };
        let resp = set_override(Json(bad)).await.into_response();
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn handler_remove_override_idempotent_when_missing() {
        let _lock = acquire_lock().await;
        let _dir = sandbox_grove_dir();
        // DELETE is idempotent: returns 204 whether the override existed or not.
        let resp = remove_override(axum::extract::Path("nonexistent".to_string()))
            .await
            .into_response();
        assert_eq!(resp.status(), StatusCode::NO_CONTENT);
    }

    #[tokio::test]
    async fn handler_set_override_accepts_empty_key_as_unbind() {
        let _lock = acquire_lock().await;
        let _dir = sandbox_grove_dir();
        // Empty key = unbind (override row shadows catalog defaults).
        let unbind = KeymapOverride {
            command_id: "task.archive".to_string(),
            key: "".to_string(),
            when_ctx: None,
            scope: None,
        };
        let resp = set_override(Json(unbind)).await.into_response();
        assert_eq!(resp.status(), StatusCode::NO_CONTENT);
    }

    #[tokio::test]
    async fn set_overrides_stores_and_replaces_multiple_bindings() {
        let _lock = acquire_lock().await;
        let _dir = sandbox_grove_dir();

        // A command can hold multiple bindings (VSCode/Zed style).
        keymap::set_overrides(
            "panel.artifacts.open",
            &[
                KeymapOverride {
                    command_id: "panel.artifacts.open".to_string(),
                    key: "Mod+1".to_string(),
                    when_ctx: None,
                    scope: Some("workspace".to_string()),
                },
                KeymapOverride {
                    command_id: "panel.artifacts.open".to_string(),
                    key: "Mod+2".to_string(),
                    when_ctx: None,
                    scope: Some("workspace".to_string()),
                },
            ],
        )
        .unwrap();
        let mut keys: Vec<String> = keymap::load_bundle()
            .unwrap()
            .overrides
            .iter()
            .filter(|o| o.command_id == "panel.artifacts.open")
            .map(|o| o.key.clone())
            .collect();
        keys.sort();
        assert_eq!(keys, vec!["Mod+1".to_string(), "Mod+2".to_string()]);

        // Re-setting replaces the whole set rather than appending.
        keymap::set_overrides(
            "panel.artifacts.open",
            &[KeymapOverride {
                command_id: "panel.artifacts.open".to_string(),
                key: "Mod+3".to_string(),
                when_ctx: None,
                scope: None,
            }],
        )
        .unwrap();
        let mine: Vec<String> = keymap::load_bundle()
            .unwrap()
            .overrides
            .iter()
            .filter(|o| o.command_id == "panel.artifacts.open")
            .map(|o| o.key.clone())
            .collect();
        assert_eq!(mine, vec!["Mod+3".to_string()]);
    }
}

//! Application icon catalog shared with the Appearance picker.

use once_cell::sync::Lazy;
use serde::Deserialize;

#[derive(Deserialize)]
pub struct AppIconDesign {
    pub id: String,
}

pub static DESIGNS: Lazy<Vec<AppIconDesign>> = Lazy::new(|| {
    serde_json::from_str(include_str!("../src-tauri/icons/variants/catalog.json"))
        .expect("valid built-in application icon catalog")
});

pub fn is_valid_style(style: &str) -> bool {
    DESIGNS.iter().any(|design| design.id == style)
}

#[cfg(feature = "gui")]
#[derive(rust_embed::RustEmbed)]
#[folder = "src-tauri/icons/variants/"]
struct IconAssets;

#[cfg(feature = "gui")]
pub fn png(style: &str, is_light: bool) -> Option<std::borrow::Cow<'static, [u8]>> {
    png_asset(style, is_light, "")
}

#[cfg(feature = "gui")]
pub fn tray_png(style: &str, is_light: bool) -> Option<std::borrow::Cow<'static, [u8]>> {
    png_asset(style, is_light, "-tray")
}

#[cfg(feature = "gui")]
fn png_asset(style: &str, is_light: bool, suffix: &str) -> Option<std::borrow::Cow<'static, [u8]>> {
    if !is_valid_style(style) {
        return None;
    }
    let mode = if is_light { "light" } else { "dark" };
    IconAssets::get(&format!("{style}-{mode}{suffix}.png")).map(|asset| asset.data)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_catalog_styles_but_not_asset_paths() {
        assert!(is_valid_style("classic"));
        assert!(is_valid_style("moss"));
        assert!(!is_valid_style("../icon"));
        assert!(!is_valid_style("missing"));
    }

    #[test]
    fn icon_preferences_survive_config_round_trip_and_old_configs_get_defaults() {
        let old: crate::storage::config::Config = toml::from_str("[theme]\nmode = 'dark'").unwrap();
        assert_eq!(old.theme.app_icon, "classic");
        let mut config = old;
        config.theme.app_icon = "terrarium".into();
        let saved = toml::to_string(&config).unwrap();
        let loaded: crate::storage::config::Config = toml::from_str(&saved).unwrap();
        assert_eq!(loaded.theme.app_icon, "terrarium");
    }

    #[cfg(feature = "gui")]
    #[test]
    fn every_design_has_two_decodable_native_icons() {
        for design in DESIGNS.iter() {
            for is_light in [true, false] {
                let bytes = png(&design.id, is_light).unwrap();
                let image = tauri::image::Image::from_bytes(&bytes).unwrap();
                assert_eq!((image.width(), image.height()), (1024, 1024));
                let tray = tray_png(&design.id, is_light).unwrap();
                let tray_image = tauri::image::Image::from_bytes(&tray).unwrap();
                assert_eq!((tray_image.width(), tray_image.height()), (64, 64));
                // Match the original menu-bar icon's full-canvas footprint.
                // Desktop margins would shrink every variant by about 19%.
                let occupied = tray_image
                    .rgba()
                    .chunks_exact(4)
                    .enumerate()
                    .filter(|(_, pixel)| pixel[3] >= 128)
                    .map(|(i, _)| ((i % 64) as u32, (i / 64) as u32))
                    .fold((64, 64, 0, 0), |(left, top, right, bottom), (x, y)| {
                        (left.min(x), top.min(y), right.max(x), bottom.max(y))
                    });
                assert_eq!(occupied, (0, 0, 63, 63), "{} tray footprint", design.id);
            }
        }
    }
}

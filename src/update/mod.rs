//! Update checker module
//!
//! Checks for new versions of Grove on GitHub Releases.

use chrono::{DateTime, Duration, Utc};
use semver::Version;
use std::env;

/// Installation method detected from executable path
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InstallMethod {
    /// Installed via `cargo install grove-rs`
    CargoInstall,
    /// Installed via GitHub Release (install.sh)
    GitHubRelease,
    /// Installed via Homebrew
    Homebrew,
    /// Unknown installation method
    Unknown,
}

impl InstallMethod {
    /// Returns the update command for this installation method
    pub fn update_command(&self) -> &'static str {
        match self {
            InstallMethod::CargoInstall => "cargo install grove-rs",
            InstallMethod::Homebrew => "brew upgrade grove",
            InstallMethod::GitHubRelease => {
                "curl -sSL https://raw.githubusercontent.com/GarrickZ2/grove/master/install.sh | sh"
            }
            InstallMethod::Unknown => "https://github.com/GarrickZ2/grove/releases",
        }
    }
}

/// Update information
#[derive(Debug, Clone)]
pub struct UpdateInfo {
    /// Current version (from Cargo.toml)
    pub current_version: String,
    /// Latest version from GitHub (None if check failed)
    pub latest_version: Option<String>,
    /// How the application was installed
    pub install_method: InstallMethod,
    /// When the check was performed
    pub check_time: Option<DateTime<Utc>>,
}

impl UpdateInfo {
    /// Check if an update is available
    pub fn has_update(&self) -> bool {
        let Some(latest) = &self.latest_version else {
            return false;
        };

        // Parse versions for comparison
        let current = Version::parse(self.current_version.trim_start_matches('v')).ok();
        let latest_ver = Version::parse(latest.trim_start_matches('v')).ok();

        match (current, latest_ver) {
            (Some(c), Some(l)) => l > c,
            _ => false,
        }
    }

    /// Get the update command based on installation method
    pub fn update_command(&self) -> &'static str {
        self.install_method.update_command()
    }
}

/// Detect how Grove was installed based on executable path
pub fn detect_install_method() -> InstallMethod {
    let Ok(exe_path) = env::current_exe() else {
        return InstallMethod::Unknown;
    };

    let path_str = exe_path.to_string_lossy();

    // Check for Homebrew (macOS)
    if path_str.contains("/homebrew/") || path_str.contains("/Cellar/") {
        return InstallMethod::Homebrew;
    }

    // Check for cargo install (~/.cargo/bin/)
    if path_str.contains("/.cargo/bin/") {
        return InstallMethod::CargoInstall;
    }

    // Check for install.sh default location (/usr/local/bin/)
    if path_str.starts_with("/usr/local/bin/") {
        return InstallMethod::GitHubRelease;
    }

    InstallMethod::Unknown
}

/// GitHub Release API response (minimal fields)
#[derive(serde::Deserialize)]
struct GitHubRelease {
    tag_name: String,
}

/// Check for the latest version from GitHub
///
/// Returns None if the check fails (network error, timeout, etc.)
pub fn fetch_latest_version() -> Option<String> {
    const GITHUB_API_URL: &str = "https://api.github.com/repos/GarrickZ2/grove/releases/latest";
    const TIMEOUT_SECS: u64 = 3;

    let response = ureq::get(GITHUB_API_URL)
        .set("User-Agent", "grove-rs")
        .set("Accept", "application/vnd.github.v3+json")
        .timeout(std::time::Duration::from_secs(TIMEOUT_SECS))
        .call()
        .ok()?;

    let release: GitHubRelease = response.into_json().ok()?;
    Some(release.tag_name)
}

/// Check if we should perform an update check (based on cache)
pub fn should_check(last_check: Option<&str>) -> bool {
    const CHECK_INTERVAL_HOURS: i64 = 24;

    let Some(last_check_str) = last_check else {
        return true; // Never checked before
    };

    let Ok(last_check_time) = DateTime::parse_from_rfc3339(last_check_str) else {
        return true; // Invalid timestamp, check anyway
    };

    let elapsed = Utc::now().signed_duration_since(last_check_time.with_timezone(&Utc));
    elapsed > Duration::hours(CHECK_INTERVAL_HOURS)
}

/// Perform a full update check
///
/// This function:
/// 1. Checks if we should perform a check (based on cache)
/// 2. Fetches the latest version from GitHub
/// 3. Returns UpdateInfo with results
pub fn check_for_updates(cached_version: Option<&str>, last_check: Option<&str>) -> UpdateInfo {
    let current_version = env!("CARGO_PKG_VERSION").to_string();
    let install_method = detect_install_method();

    // If we shouldn't check (within cache period), use cached version
    if !should_check(last_check) {
        return UpdateInfo {
            current_version,
            latest_version: cached_version.map(String::from),
            install_method,
            check_time: last_check
                .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
                .map(|dt| dt.with_timezone(&Utc)),
        };
    }

    // Perform the actual check
    let latest_version = fetch_latest_version();
    let check_time = Some(Utc::now());

    UpdateInfo {
        current_version,
        latest_version,
        install_method,
        check_time,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_version_comparison() {
        let info = UpdateInfo {
            current_version: "0.1.2".to_string(),
            latest_version: Some("0.1.3".to_string()),
            install_method: InstallMethod::Unknown,
            check_time: None,
        };
        assert!(info.has_update());

        let info = UpdateInfo {
            current_version: "0.1.2".to_string(),
            latest_version: Some("0.1.2".to_string()),
            install_method: InstallMethod::Unknown,
            check_time: None,
        };
        assert!(!info.has_update());

        let info = UpdateInfo {
            current_version: "0.1.2".to_string(),
            latest_version: Some("v0.1.3".to_string()), // with 'v' prefix
            install_method: InstallMethod::Unknown,
            check_time: None,
        };
        assert!(info.has_update());
    }

    #[test]
    fn test_update_commands() {
        assert_eq!(
            InstallMethod::CargoInstall.update_command(),
            "cargo install grove-rs"
        );
        assert!(InstallMethod::GitHubRelease
            .update_command()
            .contains("install.sh"));
        assert_eq!(
            InstallMethod::Homebrew.update_command(),
            "brew upgrade grove"
        );
    }
}

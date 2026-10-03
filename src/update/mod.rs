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
    /// Running as a macOS .app bundle (DMG install)
    AppBundle,
    /// Unknown installation method
    Unknown,
}

impl InstallMethod {
    /// Returns the update command for this installation method
    pub fn update_command(&self) -> &'static str {
        match self {
            InstallMethod::CargoInstall => {
                if cfg!(feature = "gui") {
                    "cargo install grove-rs --features gui"
                } else {
                    "cargo install grove-rs"
                }
            }
            InstallMethod::Homebrew => "brew update && brew upgrade garrickz2/grove/grove",
            InstallMethod::GitHubRelease => {
                if cfg!(windows) {
                    "irm https://raw.githubusercontent.com/GarrickZ2/grove/master/install.ps1 | iex"
                } else {
                    if cfg!(all(target_os = "linux", feature = "gui")) {
                        "bash -o pipefail -c 'curl -fsSL https://raw.githubusercontent.com/GarrickZ2/grove/master/install.sh | GROVE_GUI=1 sh'"
                    } else {
                        "bash -o pipefail -c 'curl -fsSL https://raw.githubusercontent.com/GarrickZ2/grove/master/install.sh | sh'"
                    }
                }
            }
            // AppBundle updates are handled in-app via the web UI
            InstallMethod::AppBundle => "",
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

/// Check if the executable directory is writable by the current process
pub fn is_executable_writable() -> bool {
    let Ok(exe_path) = env::current_exe() else {
        return false;
    };
    let Some(parent) = exe_path.parent() else {
        return false;
    };

    // Try to create a temporary file in the executable's directory to verify write access.
    // This is the most cross-platform, deterministic and reliable check.
    let temp_file = parent.join(format!(".grove_write_test_{}", uuid::Uuid::new_v4()));
    match std::fs::File::create(&temp_file) {
        Ok(_) => {
            let _ = std::fs::remove_file(temp_file);
            true
        }
        Err(_) => false,
    }
}

/// Detect how Grove was installed based on executable path
pub fn detect_install_method() -> InstallMethod {
    let Ok(exe_path) = env::current_exe() else {
        return InstallMethod::Unknown;
    };

    let path_str = exe_path.to_string_lossy();

    // Check for macOS .app bundle (highest priority on macOS)
    if path_str.contains(".app/Contents/MacOS/") {
        return InstallMethod::AppBundle;
    }

    // Check for Homebrew (macOS)
    if path_str.contains("/homebrew/") || path_str.contains("/Cellar/") {
        return InstallMethod::Homebrew;
    }

    // Check for cargo install (~/.cargo/bin/)
    if path_str.contains("/.cargo/bin/") || path_str.contains("\\.cargo\\bin\\") {
        return InstallMethod::CargoInstall;
    }

    // Check for install.sh/install.ps1 location (user-local or system-wide)
    if path_str.starts_with("/usr/local/bin/")
        || path_str.contains("/.local/bin/")
        || path_str.contains("Programs/Grove")
        || path_str.contains("Programs\\Grove")
    {
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

/// Ignore the startup cache and install a newer release using the detected
/// installation method. This is the explicit `grove upgrade` path.
pub fn upgrade() -> Result<(), String> {
    let update_info = check_for_updates(None, None);
    let latest = update_info
        .latest_version
        .as_deref()
        .ok_or("could not check the latest GitHub release")?;
    Version::parse(latest.trim_start_matches('v'))
        .map_err(|error| format!("invalid latest release version {latest}: {error}"))?;

    let mut config = crate::storage::config::load_config();
    config.update.latest_version = Some(latest.to_string());
    config.update.last_check = update_info.check_time.map(|time| time.to_rfc3339());
    if let Err(error) = crate::storage::config::save_config(&config) {
        eprintln!("Could not save update check: {error}");
    }

    if !update_info.has_update() {
        println!(
            "Grove {} is already up to date.",
            update_info.current_version
        );
        return Ok(());
    }

    let command = match update_info.install_method {
        InstallMethod::AppBundle => {
            return Err("macOS app bundles must be updated from the Grove app".to_string());
        }
        InstallMethod::Unknown => {
            return Err("unknown installation method; update Grove manually".to_string());
        }
        _ => update_info.update_command(),
    };

    println!("Upgrading Grove {} → {latest}", update_info.current_version);
    println!("Executing: {command}");
    execute_and_verify_update(command, update_info.install_method, latest)?;
    println!("Update completed. Restart Grove to use the new version.");
    Ok(())
}

fn verify_homebrew_version(latest: &str) -> Result<(), String> {
    let output = std::process::Command::new("brew")
        .args(["list", "--versions", "garrickz2/grove/grove"])
        .output()
        .map_err(|error| format!("could not verify Homebrew installation: {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "could not verify Homebrew installation: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }

    let installed = String::from_utf8_lossy(&output.stdout);
    let version = installed
        .split_whitespace()
        .skip(1)
        .filter_map(|version| Version::parse(version).ok())
        .max()
        .ok_or("could not read the installed Homebrew version")?;
    let latest_version = Version::parse(latest.trim_start_matches('v'))
        .map_err(|error| format!("invalid latest release version {latest}: {error}"))?;
    if version < latest_version {
        return Err(format!(
            "Homebrew has Grove {version}, but GitHub has {latest}; the tap formula may not be published yet"
        ));
    }
    Ok(())
}

fn verify_installed_version(exe: &std::path::Path, latest: &str) -> Result<(), String> {
    let output = std::process::Command::new(exe)
        .arg("--version")
        .output()
        .map_err(|error| format!("could not verify installed Grove: {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "installed Grove did not report its version: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    let reported = String::from_utf8_lossy(&output.stdout);
    let installed = reported
        .split_whitespace()
        .last()
        .and_then(|value| Version::parse(value.trim_start_matches('v')).ok())
        .ok_or_else(|| {
            format!(
                "could not parse installed Grove version: {}",
                reported.trim()
            )
        })?;
    let expected = Version::parse(latest.trim_start_matches('v'))
        .map_err(|error| format!("invalid latest release version {latest}: {error}"))?;
    if installed < expected {
        return Err(format!(
            "Grove is still {installed}, but the latest release is {expected}"
        ));
    }
    Ok(())
}

fn verify_update_result(
    method: InstallMethod,
    latest: &str,
    exe: &std::path::Path,
) -> Result<(), String> {
    if method == InstallMethod::Homebrew {
        verify_homebrew_version(latest)
    } else {
        verify_installed_version(exe, latest)
    }
}

fn execute_and_verify_update(
    command: &str,
    method: InstallMethod,
    latest: &str,
) -> Result<(), String> {
    // Capture the path before the installer replaces the running executable.
    // On Linux, current_exe() can then point at the unlinked old inode.
    let exe =
        env::current_exe().map_err(|error| format!("could not locate Grove binary: {error}"))?;
    execute_update_command(command)?;
    verify_update_result(method, latest, &exe)
}

fn execute_update_command(command: &str) -> Result<(), String> {
    use std::process::Command;

    let status = if cfg!(windows) {
        Command::new("powershell")
            .args(["-Command", command])
            .status()
    } else {
        Command::new("sh").args(["-c", command]).status()
    }
    .map_err(|error| format!("could not execute update command: {error}"))?;

    if status.success() {
        Ok(())
    } else {
        Err(format!("update command exited with status {status}"))
    }
}

/// Prompt the user in the CLI to update if a new version is available.
/// If they choose to update, execute the installation command and exit.
/// Otherwise, continue starting the application.
pub fn prompt_and_execute_update(update_info: &UpdateInfo) {
    use std::io::{self, IsTerminal, Write};

    // Check if stdin is a terminal to avoid hanging in non-interactive/AppBundle environments
    if !io::stdin().is_terminal() {
        return;
    }

    let Some(latest) = &update_info.latest_version else {
        return;
    };

    let command_str = update_info.update_command();
    if command_str.is_empty() {
        return; // AppBundle updates are handled in-app via the web UI/Tauri
    }

    println!("\nA new version is available: {}", latest);
    println!(
        "It is recommended to update. The update command is:\n  {}",
        command_str
    );
    print!("Would you like to auto-update now? [y/N]: ");
    let _ = io::stdout().flush();

    let mut input = String::new();
    if io::stdin().read_line(&mut input).is_ok() {
        let trimmed = input.trim().to_lowercase();
        if trimmed == "y" || trimmed == "yes" {
            println!("Executing update command: {}\n", command_str);

            match execute_and_verify_update(command_str, update_info.install_method, latest) {
                Ok(()) => {
                    println!("\nUpdate completed! Please restart Grove.");
                    std::process::exit(0);
                }
                Err(error) => {
                    eprintln!("\nUpdate failed: {error}");
                    print!("Press Enter to continue starting Grove...");
                    let _ = io::stdout().flush();
                    let mut dummy = String::new();
                    let _ = io::stdin().read_line(&mut dummy);
                }
            }
        }
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
            if cfg!(feature = "gui") {
                "cargo install grove-rs --features gui"
            } else {
                "cargo install grove-rs"
            }
        );
        assert!(InstallMethod::GitHubRelease
            .update_command()
            .contains(if cfg!(windows) {
                "install.ps1"
            } else {
                "install.sh"
            }));
        assert_eq!(
            InstallMethod::Homebrew.update_command(),
            "brew update && brew upgrade garrickz2/grove/grove"
        );
        assert_eq!(InstallMethod::AppBundle.update_command(), "");
    }
}

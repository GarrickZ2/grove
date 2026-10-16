//! Download the official iOS artifact. Signing and installation belong to the user.
use sha2::{Digest, Sha256};
use std::{
    fs::File,
    io::{self, Read},
    path::{Path, PathBuf},
    time::Duration,
};

const RELEASE_API: &str = "https://api.github.com/repos/GarrickZ2/grove/releases/latest";
const RELEASES: &str = "https://github.com/GarrickZ2/grove/releases";
type DownloadResult<T> = Result<T, Box<dyn std::error::Error>>;

#[derive(serde::Deserialize)]
struct Release {
    tag_name: String,
    assets: Vec<Asset>,
}
#[derive(serde::Deserialize)]
struct Asset {
    name: String,
    browser_download_url: String,
    size: u64,
    digest: Option<String>,
}

fn select_ipa(release: &Release) -> DownloadResult<&Asset> {
    let assets: Vec<_> = release
        .assets
        .iter()
        .filter(|a| a.name.to_ascii_lowercase().ends_with(".ipa"))
        .collect();
    match assets.as_slice() {
        [asset] => Ok(asset),
        [] => Err(format!("Release {} has no iOS IPA attached yet. See {RELEASES}. No file was downloaded.", release.tag_name).into()),
        _ => assets.iter().find(|a| a.name == "Grove.ipa").copied().ok_or_else(|| "Release contains multiple IPA files without a Grove.ipa; cannot choose automatically.".into()),
    }
}

struct PendingFile(PathBuf);
impl Drop for PendingFile {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

fn save_ipa(
    mut reader: impl Read,
    directory: &Path,
    version: &str,
    asset: &Asset,
) -> DownloadResult<PathBuf> {
    if version.is_empty()
        || !version
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b".-_".contains(&c))
    {
        return Err("Release has an invalid version tag.".into());
    }
    std::fs::create_dir_all(directory)?;
    let temporary = directory.join(format!(".grove-{}.ipa", uuid::Uuid::new_v4()));
    let mut file = File::options()
        .write(true)
        .create_new(true)
        .open(&temporary)?;
    let pending = PendingFile(temporary);
    let copied = io::copy(&mut reader, &mut file)?;
    file.sync_all()?;
    drop(file);
    if copied != asset.size || copied == 0 {
        return Err("IPA download is incomplete (release size mismatch).".into());
    }
    validate_ipa(&pending.0)?;
    let checksum = |path: &Path| -> DownloadResult<String> {
        let mut digest = Sha256::new();
        io::copy(&mut File::open(path)?, &mut digest)?;
        Ok(format!("{:x}", digest.finalize()))
    };
    let digest = checksum(&pending.0)?;
    if let Some(expected) = asset
        .digest
        .as_deref()
        .and_then(|d| d.strip_prefix("sha256:"))
    {
        if !digest.eq_ignore_ascii_case(expected) {
            return Err("IPA SHA256 does not match the release asset.".into());
        }
    }
    let destination = directory.join(format!("Grove-{version}.ipa"));
    // Publish the validated file atomically without overwriting existing files.
    match std::fs::hard_link(&pending.0, &destination) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
            if checksum(&destination)? != digest {
                return Err(format!(
                    "{} already exists with different contents. Move it before retrying.",
                    destination.display()
                )
                .into());
            }
        }
        Err(error) => return Err(error.into()),
    }
    Ok(destination)
}

pub fn execute() -> DownloadResult<()> {
    println!("Looking up the latest Grove iOS release...");
    let release: Release = ureq::get(RELEASE_API)
        .set("User-Agent", "grove-rs")
        .set("Accept", "application/vnd.github+json")
        .timeout(Duration::from_secs(30))
        .call()?
        .into_json()?;
    let asset = select_ipa(&release)?;
    let directory = dirs::download_dir()
        .or_else(|| dirs::home_dir().map(|home| home.join("Downloads")))
        .ok_or("Could not locate your Downloads directory.")?;
    println!("Downloading {} from {}...", asset.name, release.tag_name);
    let response = ureq::get(&asset.browser_download_url)
        .set("User-Agent", "grove-rs")
        .timeout(Duration::from_secs(600))
        .call()?;
    let path = save_ipa(response.into_reader(), &directory, &release.tag_name, asset)?;
    println!(
        "IPA saved to: {}\nUse your preferred tool to sign and install it on your iPhone.",
        path.display()
    );
    Ok(())
}

/// Check the archive without extracting or executing anything from it.
fn validate_ipa(path: &Path) -> DownloadResult<String> {
    if !path
        .extension()
        .is_some_and(|extension| extension.eq_ignore_ascii_case("ipa"))
    {
        return Err("The selected file must have an .ipa extension.".into());
    }
    let mut archive = zip::ZipArchive::new(File::open(path)?)?;
    let manifests: Vec<String> = archive
        .file_names()
        .filter(|name| {
            let parts: Vec<_> = name.split('/').collect();
            parts.len() == 3
                && parts[0] == "Payload"
                && parts[1].ends_with(".app")
                && parts[2] == "Info.plist"
        })
        .map(str::to_owned)
        .collect();
    if manifests.len() != 1 {
        return Err("Expected one Payload/*.app/Info.plist in the IPA.".into());
    }
    let info = {
        let entry = archive.by_name(&manifests[0])?;
        if entry.size() > 1024 * 1024 {
            return Err("IPA Info.plist is unexpectedly large.".into());
        }
        let mut bytes = Vec::new();
        entry.take(1024 * 1024 + 1).read_to_end(&mut bytes)?;
        plist::Value::from_reader(io::Cursor::new(bytes))?
    };
    let info = info.as_dictionary().ok_or("Invalid IPA Info.plist.")?;
    let device_build = info.get("DTPlatformName").and_then(plist::Value::as_string)
        == Some("iphoneos")
        || info
            .get("CFBundleSupportedPlatforms")
            .and_then(plist::Value::as_array)
            .is_some_and(|platforms| platforms.iter().any(|p| p.as_string() == Some("iPhoneOS")));
    if !device_build {
        return Err(
            "This is not an iPhone device build (simulator apps cannot be sideloaded).".into(),
        );
    }
    let executable = info
        .get("CFBundleExecutable")
        .and_then(plist::Value::as_string)
        .filter(|name| !name.is_empty() && !name.contains('/') && !name.contains('\\'))
        .ok_or("IPA has no valid executable name.")?;
    let directory = manifests[0].strip_suffix("Info.plist").unwrap();
    if archive.by_name(&format!("{directory}{executable}"))?.size() == 0 {
        return Err("IPA executable is empty.".into());
    }
    Ok(info
        .get("CFBundleShortVersionString")
        .and_then(plist::Value::as_string)
        .unwrap_or("unknown")
        .to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    fn fixture(path: &Path, platform: &str, executable: bool) {
        let mut zip = zip::ZipWriter::new(File::create(path).unwrap());
        let options = zip::write::SimpleFileOptions::default();
        zip.start_file("Payload/Grove.app/Info.plist", options)
            .unwrap();
        write!(zip, r#"<?xml version="1.0"?><plist version="1.0"><dict><key>DTPlatformName</key><string>{platform}</string><key>CFBundleExecutable</key><string>Grove</string><key>CFBundleShortVersionString</key><string>1.2.3</string></dict></plist>"#).unwrap();
        if executable {
            zip.start_file("Payload/Grove.app/Grove", options).unwrap();
            zip.write_all(b"fixture executable").unwrap();
        }
        zip.finish().unwrap();
    }

    #[test]
    fn validates_device_archive_and_rejects_simulator_or_missing_binary() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("Grove.ipa");
        fixture(&path, "iphoneos", true);
        assert_eq!(validate_ipa(&path).unwrap(), "1.2.3");
        fixture(&path, "iphonesimulator", true);
        assert!(validate_ipa(&path).is_err());
        fixture(&path, "iphoneos", false);
        assert!(validate_ipa(&path).is_err());
    }

    #[test]
    fn downloads_validate_before_publish_and_never_overwrite_different_files() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("fixture.ipa");
        fixture(&source, "iphoneos", true);
        let bytes = std::fs::read(&source).unwrap();
        let asset = Asset {
            name: "Grove.ipa".into(),
            browser_download_url: String::new(),
            size: bytes.len() as u64,
            digest: Some(format!("sha256:{:x}", Sha256::digest(&bytes))),
        };
        let downloads = dir.path().join("Downloads");
        let path = save_ipa(bytes.as_slice(), &downloads, "v1.2.3", &asset).unwrap();
        assert_eq!(path.file_name().unwrap(), "Grove-v1.2.3.ipa");
        assert_eq!(
            save_ipa(bytes.as_slice(), &downloads, "v1.2.3", &asset).unwrap(),
            path
        );
        std::fs::write(&path, b"keep me").unwrap();
        assert!(save_ipa(bytes.as_slice(), &downloads, "v1.2.3", &asset).is_err());
        assert_eq!(std::fs::read(&path).unwrap(), b"keep me");
        assert!(save_ipa(&bytes[..4], &downloads, "v1.2.4", &asset).is_err());
        assert!(save_ipa(bytes.as_slice(), &downloads, "../escape", &asset).is_err());
        let bad = Asset {
            digest: Some("sha256:bad".into()),
            ..asset
        };
        assert!(save_ipa(bytes.as_slice(), &downloads, "v1.2.5", &bad).is_err());
        assert_eq!(std::fs::read_dir(&downloads).unwrap().count(), 1);
    }
    #[test]
    fn reports_missing_release_artifacts_and_parses_new_command() {
        use clap::Parser;
        assert!(select_ipa(&Release {
            tag_name: "v1".into(),
            assets: vec![]
        })
        .err()
        .unwrap()
        .to_string()
        .contains("no iOS IPA"));
        assert!(crate::cli::Cli::try_parse_from(["grove", "device", "ios"]).is_ok());
        assert!(crate::cli::Cli::try_parse_from(["grove", "ios"]).is_err());
        assert!(
            crate::cli::Cli::try_parse_from(["grove", "device", "ios", "--via", "sideloadly"])
                .is_err()
        );
    }
}

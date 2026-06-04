//! Binary install machinery for the agent marketplace.
//!
//! For agents whose registry entry provides per-platform `binary` archives,
//! grove downloads the archive matching the current OS/arch, extracts it
//! under `~/.grove/agents/<id>/<version>/`, and records `install_path` in
//! the SQLite `installed_agents` row. Run-time launch (P5+) picks the
//! `cmd` from the entry and runs it relative to that install_path.
//!
//! Uninstall removes the extracted directory (and only that directory —
//! the SQL row uninstall path checks containment under `~/.grove/agents/`).

use std::io::Read;
use std::path::{Path, PathBuf};

use crate::error::{GroveError, Result};
use crate::storage::agent_registry::BinaryTarget;

/// Map current platform to the registry's `<os>-<arch>` keys. Returns the
/// short string used as a HashMap key in `Distribution.binary`.
pub fn current_platform_key() -> &'static str {
    // We list every case the registry currently uses (cross-checked against
    // observed live data). Unknown combos fall through to a synthetic value
    // that will never match — better than a wrong match.
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    {
        "darwin-aarch64"
    }
    #[cfg(all(target_os = "macos", target_arch = "x86_64"))]
    {
        "darwin-x86_64"
    }
    #[cfg(all(target_os = "linux", target_arch = "aarch64"))]
    {
        "linux-aarch64"
    }
    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    {
        "linux-x86_64"
    }
    #[cfg(all(target_os = "windows", target_arch = "x86_64"))]
    {
        "windows-x86_64"
    }
    #[cfg(not(any(
        all(target_os = "macos", target_arch = "aarch64"),
        all(target_os = "macos", target_arch = "x86_64"),
        all(target_os = "linux", target_arch = "aarch64"),
        all(target_os = "linux", target_arch = "x86_64"),
        all(target_os = "windows", target_arch = "x86_64"),
    )))]
    {
        "unsupported-platform"
    }
}

/// Filesystem layout: `~/.grove/agents/<id>/<version>/`.
pub fn install_dir(agent_id: &str, version: &str) -> PathBuf {
    crate::storage::grove_dir()
        .join("agents")
        .join(agent_id)
        .join(version)
}

/// Download + extract a binary archive. Heavy IO — caller must drive this
/// inside `tokio::task::spawn_blocking` or otherwise off the async runtime.
///
/// Returns the install_path (absolute) on success, ready to be stored on
/// `InstalledAgent.install_path`. Cleans up the target dir on failure so
/// retries land on a clean slate.
pub async fn download_and_extract(
    agent_id: &str,
    version: &str,
    target: &BinaryTarget,
) -> Result<PathBuf> {
    let dest = install_dir(agent_id, version);

    // Wipe any partial install from a previous attempt — keeps semantics
    // simple ("install_path always points at a valid extracted archive").
    if dest.exists() {
        std::fs::remove_dir_all(&dest).ok();
    }
    std::fs::create_dir_all(&dest)?;

    let archive_url = target.archive.clone();
    let bytes = fetch_archive(&archive_url).await?;
    let archive_kind = detect_archive_kind(&archive_url);

    // Extraction is purely blocking — run on a worker thread.
    let dest_clone = dest.clone();
    let extract_result = tokio::task::spawn_blocking(move || match archive_kind {
        ArchiveKind::TarGz => extract_tar_gz(&bytes, &dest_clone),
        ArchiveKind::Zip => extract_zip(&bytes, &dest_clone),
    })
    .await
    .map_err(|e| GroveError::storage(format!("extract task: {}", e)))?;

    if let Err(e) = extract_result {
        // Best-effort cleanup so the next attempt starts fresh.
        let _ = std::fs::remove_dir_all(&dest);
        return Err(e);
    }

    // chmod +x on the cmd binary (and anything in extracted dir that looks
    // like an executable). Windows ignores this entirely.
    #[cfg(unix)]
    {
        let cmd_path = dest.join(target.cmd.trim_start_matches("./"));
        if cmd_path.exists() {
            mark_executable(&cmd_path)?;
        } else {
            // Some archives put the binary one level deep. We don't try to
            // outsmart that — the launcher resolves `target.cmd` literally
            // and will error loudly if the path is wrong. But mark every
            // top-level file executable as a safety net for `./cmd` -style
            // entries that resolve to extracted_root/<exe>.
            for entry in std::fs::read_dir(&dest)?.flatten() {
                if entry.path().is_file() {
                    let _ = mark_executable(&entry.path());
                }
            }
        }
    }

    Ok(dest)
}

#[derive(Debug, Clone, Copy)]
enum ArchiveKind {
    TarGz,
    Zip,
}

fn detect_archive_kind(url: &str) -> ArchiveKind {
    let lower = url.to_lowercase();
    if lower.ends_with(".zip") {
        ArchiveKind::Zip
    } else {
        // Catch-all for .tar.gz / .tgz / .tar / unknown — tar is the dominant
        // format in the live registry; we treat unknown as tar.gz to fail at
        // extract time (rather than a smarter sniffer that masks bugs).
        ArchiveKind::TarGz
    }
}

async fn fetch_archive(url: &str) -> Result<Vec<u8>> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(180))
        .build()
        .map_err(|e| GroveError::storage(format!("reqwest build: {}", e)))?;
    let resp = client
        .get(url)
        .send()
        .await
        .map_err(|e| GroveError::storage(format!("download {}: {}", url, e)))?;
    if !resp.status().is_success() {
        return Err(GroveError::storage(format!(
            "download {} HTTP {}",
            url,
            resp.status()
        )));
    }
    let bytes = resp
        .bytes()
        .await
        .map_err(|e| GroveError::storage(format!("download body: {}", e)))?;
    Ok(bytes.to_vec())
}

fn extract_tar_gz(bytes: &[u8], dest: &Path) -> Result<()> {
    let decoder = flate2::read::GzDecoder::new(bytes);
    let mut archive = tar::Archive::new(decoder);
    for entry in archive
        .entries()
        .map_err(|e| GroveError::storage(format!("tar entries: {}", e)))?
    {
        let mut entry = entry.map_err(|e| GroveError::storage(format!("tar entry: {}", e)))?;
        let path = entry
            .path()
            .map_err(|e| GroveError::storage(format!("tar path: {}", e)))?
            .into_owned();
        let safe = sanitize_extract_path(dest, &path)?;
        if let Some(parent) = safe.parent() {
            std::fs::create_dir_all(parent)?;
        }
        entry
            .unpack(&safe)
            .map_err(|e| GroveError::storage(format!("tar unpack: {}", e)))?;
    }
    Ok(())
}

pub(crate) fn extract_zip(bytes: &[u8], dest: &Path) -> Result<()> {
    let reader = std::io::Cursor::new(bytes);
    let mut zip = zip::ZipArchive::new(reader)
        .map_err(|e| GroveError::storage(format!("zip open: {}", e)))?;
    for i in 0..zip.len() {
        let mut file = zip
            .by_index(i)
            .map_err(|e| GroveError::storage(format!("zip entry: {}", e)))?;
        let raw_name = match file.enclosed_name() {
            Some(p) => p.to_path_buf(),
            None => continue, // zip-slip attempt — skip silently
        };
        let safe = sanitize_extract_path(dest, &raw_name)?;
        if file.is_dir() {
            std::fs::create_dir_all(&safe)?;
            continue;
        }
        if let Some(parent) = safe.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let mut out = std::fs::File::create(&safe)?;
        let mut buf = Vec::with_capacity(file.size() as usize);
        file.read_to_end(&mut buf)
            .map_err(|e| GroveError::storage(format!("zip read: {}", e)))?;
        std::io::Write::write_all(&mut out, &buf)?;
        #[cfg(unix)]
        {
            if let Some(mode) = file.unix_mode() {
                use std::os::unix::fs::PermissionsExt;
                let _ = std::fs::set_permissions(&safe, std::fs::Permissions::from_mode(mode));
            }
        }
    }
    Ok(())
}

/// Refuse zip-slip / path traversal: any extracted path must resolve to a
/// descendant of `dest`. Returns the joined absolute path on success.
///
/// `pub` because `marketplace::install_binary` reuses it to validate the
/// registry-provided `target.cmd` before storing it as `install_path` — a
/// malicious registry could otherwise hand us a `cmd` with `..` segments
/// that escape `~/.grove/agents/<id>/<ver>/` and have grove spawn an
/// attacker-chosen system binary.
pub fn sanitize_extract_path(dest: &Path, entry: &Path) -> Result<PathBuf> {
    let joined = dest.join(entry);
    // Normalize without touching the filesystem — we can't canonicalize
    // because the file doesn't exist yet.
    let mut normalized = PathBuf::new();
    for component in joined.components() {
        match component {
            std::path::Component::ParentDir => {
                if !normalized.pop() {
                    return Err(GroveError::storage(format!(
                        "archive entry escapes install dir: {:?}",
                        entry
                    )));
                }
            }
            std::path::Component::CurDir => {}
            other => normalized.push(other.as_os_str()),
        }
    }
    if !normalized.starts_with(dest) {
        return Err(GroveError::storage(format!(
            "archive entry escapes install dir: {:?}",
            entry
        )));
    }
    Ok(normalized)
}

#[cfg(unix)]
fn mark_executable(path: &Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    let meta = std::fs::metadata(path)?;
    let mut perms = meta.permissions();
    let mode = perms.mode() | 0o111; // add x for owner/group/other
    perms.set_mode(mode);
    std::fs::set_permissions(path, perms)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detect_archive_kind_zip() {
        assert!(matches!(
            detect_archive_kind("https://example/x.zip"),
            ArchiveKind::Zip
        ));
        assert!(matches!(
            detect_archive_kind("https://example/x.tar.gz"),
            ArchiveKind::TarGz
        ));
        assert!(matches!(
            detect_archive_kind("https://example/unknown"),
            ArchiveKind::TarGz
        ));
    }

    #[test]
    fn sanitize_rejects_parent_traversal() {
        let dest = Path::new("/tmp/install");
        assert!(sanitize_extract_path(dest, Path::new("../etc/passwd")).is_err());
        assert!(sanitize_extract_path(dest, Path::new("ok/file")).is_ok());
    }

    #[test]
    fn platform_key_is_one_of_known() {
        // Just verify we return a non-empty string with a `-` in it.
        let k = current_platform_key();
        assert!(k.contains('-'), "got {:?}", k);
    }
}

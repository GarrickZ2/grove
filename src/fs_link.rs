use std::path::Path;

/// Create a cross-platform filesystem link.
///
/// Platform strategy:
/// - **Unix (macOS / Linux)**: symlink for both files and directories. Symlinks
///   survive atomic-rename writes (editors like Claude Code, VS Code, vim save
///   by writing to a temp file and renaming — this would sever a hardlink but
///   leaves a symlink intact). No elevated permissions required.
/// - **Windows**: hard link for files, junction for directories. Avoids the
///   Developer Mode / admin requirement of Windows symlinks. Hardlinks on
///   Windows are vulnerable to the same atomic-rename issue, but most Windows
///   editors do not use atomic-rename by default.
pub fn create_link(source: &Path, target: &Path) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        // Symlink works for both files and directories on Unix.
        std::os::unix::fs::symlink(source, target)
    }
    #[cfg(windows)]
    {
        if source.is_dir() {
            junction::create(source, target)
        } else {
            std::fs::hard_link(source, target)
        }
    }
    #[cfg(not(any(unix, windows)))]
    {
        Err(std::io::Error::new(
            std::io::ErrorKind::Unsupported,
            "Linking not supported on this platform",
        ))
    }
}

/// Returns true if the path is a filesystem link created by `create_link`.
///
/// On Unix this checks for symlinks. On Windows this additionally detects
/// junction points, which do not report as symlinks via `is_symlink()`.
pub fn is_link(path: &Path) -> bool {
    if path.is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        junction::exists(path).unwrap_or(false)
    }
    #[cfg(not(windows))]
    false
}

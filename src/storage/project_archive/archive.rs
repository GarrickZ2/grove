//! tar.gz writer and safe extractor for project archives.
//!
//! Layout: `manifest.json`, `db/<table>.json`, `files/<root-name>/<relative path>`.

use std::collections::BTreeMap;
use std::fs;
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};

use flate2::read::GzDecoder;
use flate2::write::GzEncoder;
use flate2::Compression;
use tar::EntryType;
use walkdir::WalkDir;

use super::tables::Row;
use crate::error::{GroveError, Result};

fn append_bytes<W: Write>(b: &mut tar::Builder<W>, path: &str, data: &[u8]) -> Result<()> {
    let mut h = tar::Header::new_gnu();
    h.set_size(data.len() as u64);
    h.set_mode(0o644);
    h.set_mtime(0);
    h.set_entry_type(EntryType::Regular);
    b.append_data(&mut h, path, data)?;
    Ok(())
}

/// True if `rel` (relative to `~/.grove/projects/<hash>/`) is per-machine
/// runtime state, rebuilt on demand and never archived or imported:
/// - `index.db[-wal|-shm]` — the code symbol index (`symbols::store`);
/// - `tasks/<task>/chats/<chat>/session.json` — an Agent's live process
///   handle (`acp`, written on SessionReady);
/// - `tasks/<task>/chats/<chat>/agent.log`, `tasks/<task>/agent.log` — Agent
///   stderr (`acp::agent_log_path`).
///
/// Only the project dir holds these; Studio dirs hold user files, which are
/// never matched.
pub(crate) fn is_project_runtime_file(rel: &Path) -> bool {
    let parts: Vec<&str> = rel
        .components()
        .filter_map(|c| match c {
            Component::Normal(s) => s.to_str(),
            _ => None,
        })
        .collect();
    matches!(
        parts.as_slice(),
        ["index.db" | "index.db-wal" | "index.db-shm"]
            | ["tasks", _, "chats", _, "session.json" | "agent.log"]
            | ["tasks", _, "agent.log"]
    )
}

/// Write the archive to `out` (atomically; errors if `out` exists).
/// Returns the number of files written under `files/`. Symlinks are skipped.
pub(crate) fn write_archive(
    out: &Path,
    manifest_json: &[u8],
    tables: &BTreeMap<String, Vec<Row>>,
    file_roots: &[(&str, PathBuf)],
) -> Result<usize> {
    if out.exists() {
        return Err(GroveError::storage(format!(
            "output already exists: {}",
            out.display()
        )));
    }
    let parent = match out.parent() {
        Some(p) if !p.as_os_str().is_empty() => p,
        _ => Path::new("."),
    };
    let tmp = tempfile::NamedTempFile::new_in(parent)?;
    let mut files = 0usize;
    {
        let gz = GzEncoder::new(tmp.as_file(), Compression::default());
        let mut b = tar::Builder::new(gz);
        append_bytes(&mut b, "manifest.json", manifest_json)?;
        for (name, rows) in tables {
            let data = serde_json::to_vec(rows)
                .map_err(|e| GroveError::storage(format!("encode table {name}: {e}")))?;
            append_bytes(&mut b, &format!("db/{name}.json"), &data)?;
        }
        for (root_name, root) in file_roots {
            if !root.is_dir() {
                continue;
            }
            for entry in WalkDir::new(root).follow_links(false).sort_by_file_name() {
                let entry = entry.map_err(|e| GroveError::storage(e.to_string()))?;
                if !entry.file_type().is_file() {
                    continue; // directories are implied; symlinks skipped
                }
                let rel = entry
                    .path()
                    .strip_prefix(root)
                    .map_err(|e| GroveError::storage(e.to_string()))?;
                if *root_name == "project" && is_project_runtime_file(rel) {
                    continue;
                }
                let mut f = fs::File::open(entry.path())?;
                b.append_file(Path::new("files").join(root_name).join(rel), &mut f)?;
                files += 1;
            }
        }
        b.into_inner()?.finish()?;
    }
    tmp.persist_noclobber(out)
        .map_err(|e| GroveError::storage(format!("write {}: {}", out.display(), e.error)))?;
    Ok(files)
}

fn unsafe_entry(path: &Path, why: &str) -> GroveError {
    GroveError::invalid_data(format!("unsafe archive entry {}: {why}", path.display()))
}

fn check_entry<R: Read>(entry: &tar::Entry<'_, R>) -> Result<()> {
    let path = entry.path()?.into_owned();
    match entry.header().entry_type() {
        EntryType::Regular | EntryType::Directory => {}
        other => {
            return Err(unsafe_entry(
                &path,
                &format!("not a regular file or directory ({other:?})"),
            ))
        }
    }
    for c in path.components() {
        match c {
            Component::Normal(_) | Component::CurDir => {}
            Component::ParentDir => return Err(unsafe_entry(&path, "contains `..`")),
            Component::RootDir | Component::Prefix(_) => {
                return Err(unsafe_entry(&path, "absolute path"))
            }
        }
    }
    Ok(())
}

fn not_an_archive(e: impl std::fmt::Display) -> GroveError {
    GroveError::invalid_data(format!("not a valid Grove archive: {e}"))
}

/// Extract `archive` into `dest`, validating each entry before it is
/// written. On error `dest` may hold a partial extract; callers extract into
/// a throwaway dir. Modes, owners and times from the archive are ignored, so
/// a hostile `0o000` or setuid entry has no effect.
pub(crate) fn extract_archive(archive: &Path, dest: &Path) -> Result<()> {
    let file = fs::File::open(archive)?;
    fs::create_dir_all(dest)?;
    let mut entries = 0usize;
    for entry in tar::Archive::new(GzDecoder::new(file))
        .entries()
        .map_err(not_an_archive)?
    {
        let mut entry = entry.map_err(not_an_archive)?;
        check_entry(&entry)?;
        entries += 1;
        // Only normal components (checked above), so this stays inside `dest`.
        let target = dest.join(entry.path()?);
        if entry.header().entry_type() == EntryType::Directory {
            fs::create_dir_all(&target)?;
            continue;
        }
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent)?;
        }
        let mut out = fs::File::create(&target)?;
        std::io::copy(&mut entry, &mut out).map_err(not_an_archive)?;
    }
    if entries == 0 {
        return Err(not_an_archive("no entries"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::project_archive::test_support::{hostile_tar, raw_file_header};

    /// Extraction fails and nothing lands outside the destination.
    fn assert_rejected(tar_path: &Path) {
        let outer = tempfile::tempdir().unwrap();
        let dest = outer.path().join("dest");
        let err = extract_archive(tar_path, &dest).unwrap_err();
        assert!(err.to_string().contains("unsafe archive entry"), "{err}");
        let names: Vec<_> = fs::read_dir(outer.path())
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        assert_eq!(names, ["dest"]);
        let escaped = WalkDir::new(&dest)
            .into_iter()
            .map(|e| e.unwrap())
            .any(|e| ["evil.txt", "hard", "link"].contains(&e.file_name().to_str().unwrap()));
        assert!(!escaped);
    }

    #[test]
    fn archive_round_trips_manifest_tables_and_files() {
        let src = tempfile::tempdir().unwrap();
        fs::create_dir_all(src.path().join("a/b")).unwrap();
        fs::write(src.path().join("a/b/c.txt"), b"hello").unwrap();
        fs::write(src.path().join("日本語.md"), [0u8, 1, 2, 255]).unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink("a/b/c.txt", src.path().join("link")).unwrap();

        let mut tables = BTreeMap::new();
        let mut row = Row::new();
        row.insert("k".into(), "v".into());
        tables.insert("tasks".to_string(), vec![row]);

        let out_dir = tempfile::tempdir().unwrap();
        let out = out_dir.path().join("x.tar.gz");
        let n = write_archive(
            &out,
            b"{\"format_version\":1}",
            &tables,
            &[
                ("project", src.path().to_path_buf()),
                ("studio", out_dir.path().join("missing")),
            ],
        )
        .unwrap();
        assert_eq!(n, 2);

        let dest = tempfile::tempdir().unwrap();
        extract_archive(&out, dest.path()).unwrap();
        assert_eq!(
            fs::read(dest.path().join("manifest.json")).unwrap(),
            b"{\"format_version\":1}"
        );
        let t: Vec<Row> =
            serde_json::from_slice(&fs::read(dest.path().join("db/tasks.json")).unwrap()).unwrap();
        assert_eq!(t[0]["k"], "v");
        let files = dest.path().join("files/project");
        assert_eq!(fs::read(files.join("a/b/c.txt")).unwrap(), b"hello");
        assert_eq!(fs::read(files.join("日本語.md")).unwrap(), [0u8, 1, 2, 255]);
        assert!(!files.join("link").exists());
        assert!(fs::symlink_metadata(files.join("link")).is_err());
    }

    #[test]
    fn write_archive_refuses_existing_output() {
        let dir = tempfile::tempdir().unwrap();
        let out = dir.path().join("x.tar.gz");
        fs::write(&out, b"keep").unwrap();
        let err = write_archive(&out, b"{}", &BTreeMap::new(), &[]).unwrap_err();
        assert!(err.to_string().contains("already exists"));
        assert_eq!(fs::read(&out).unwrap(), b"keep");
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1);
    }

    #[test]
    fn extract_rejects_parent_dir_entry() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("h.tar.gz");
        hostile_tar(&p, |b| {
            let h = raw_file_header(b"ok.txt", EntryType::Regular, 2);
            b.append(&h, &b"hi"[..]).unwrap();
            let h = raw_file_header(b"files/../../evil.txt", EntryType::Regular, 2);
            b.append(&h, &b"hi"[..]).unwrap();
        });
        assert_rejected(&p);
    }

    #[test]
    fn extract_rejects_absolute_entry() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("h.tar.gz");
        hostile_tar(&p, |b| {
            let h = raw_file_header(b"/tmp/evil.txt", EntryType::Regular, 2);
            b.append(&h, &b"hi"[..]).unwrap();
        });
        assert_rejected(&p);
    }

    #[test]
    fn extract_rejects_hardlink_entry() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("h.tar.gz");
        hostile_tar(&p, |b| {
            let mut h = tar::Header::new_gnu();
            h.set_entry_type(EntryType::Link);
            h.set_size(0);
            b.append_link(&mut h, "hard", "/etc/passwd").unwrap();
        });
        assert_rejected(&p);
    }

    #[test]
    fn extract_rejects_symlink_entry() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("h.tar.gz");
        hostile_tar(&p, |b| {
            let mut h = tar::Header::new_gnu();
            h.set_entry_type(EntryType::Symlink);
            h.set_size(0);
            b.append_link(&mut h, "link", "/etc/passwd").unwrap();
        });
        assert_rejected(&p);
    }

    /// Writes `files` (relative paths) under a new dir; returns it.
    fn tree(files: &[&str]) -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        for f in files {
            let p = dir.path().join(f);
            fs::create_dir_all(p.parent().unwrap()).unwrap();
            fs::write(p, "x").unwrap();
        }
        dir
    }

    const RUNTIME: &[&str] = &[
        "index.db",
        "index.db-wal",
        "index.db-shm",
        "tasks/t1/chats/c1/session.json",
        "tasks/t1/chats/c1/agent.log",
        "tasks/t1/agent.log",
    ];
    /// Same names elsewhere: user data, never skipped.
    const LOOKALIKES: &[&str] = &[
        "tasks/t1/chats/c1/history.jsonl",
        "notes/session.json",
        "memory/index.db",
        "tasks/t1/chats/c1/sub/agent.log",
        "chats/c1/session.json",
    ];

    fn archived_files(roots: &[(&str, PathBuf)]) -> Vec<String> {
        let out_dir = tempfile::tempdir().unwrap();
        let out = out_dir.path().join("x.tar.gz");
        write_archive(&out, b"{}", &BTreeMap::new(), roots).unwrap();
        let dest = tempfile::tempdir().unwrap();
        extract_archive(&out, dest.path()).unwrap();
        let mut files: Vec<String> = WalkDir::new(dest.path().join("files"))
            .into_iter()
            .map(|e| e.unwrap())
            .filter(|e| e.file_type().is_file())
            .map(|e| {
                let rel = e.path().strip_prefix(dest.path().join("files")).unwrap();
                rel.to_string_lossy().replace('\\', "/")
            })
            .collect();
        files.sort();
        files
    }

    #[test]
    fn runtime_files_under_project_dir_are_not_archived() {
        let all: Vec<&str> = RUNTIME.iter().chain(LOOKALIKES).copied().collect();
        let src = tree(&all);
        let files = archived_files(&[("project", src.path().to_path_buf())]);
        let mut expected: Vec<String> = LOOKALIKES.iter().map(|f| format!("project/{f}")).collect();
        expected.sort();
        assert_eq!(files, expected);
    }

    #[test]
    fn studio_files_with_runtime_names_are_archived() {
        let all: Vec<&str> = RUNTIME.iter().chain(LOOKALIKES).copied().collect();
        let src = tree(&all);
        let files = archived_files(&[("studio", src.path().to_path_buf())]);
        let mut expected: Vec<String> = all.iter().map(|f| format!("studio/{f}")).collect();
        expected.sort();
        assert_eq!(files, expected);
    }

    #[cfg(unix)]
    #[test]
    fn extract_ignores_hostile_mode_bits() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("m.tar.gz");
        hostile_tar(&p, |b| {
            let mut h = raw_file_header(b"files/locked/", EntryType::Directory, 0);
            h.set_mode(0o000);
            h.set_cksum();
            b.append(&h, &b""[..]).unwrap();
            let mut h = raw_file_header(b"files/locked/f.txt", EntryType::Regular, 2);
            h.set_mode(0o000);
            h.set_cksum();
            b.append(&h, &b"hi"[..]).unwrap();
            let mut h = raw_file_header(b"files/run.sh", EntryType::Regular, 2);
            h.set_mode(0o4777);
            h.set_cksum();
            b.append(&h, &b"hi"[..]).unwrap();
        });
        let dest = tempfile::tempdir().unwrap();
        extract_archive(&p, dest.path()).unwrap();
        let locked = dest.path().join("files/locked");
        assert_eq!(
            fs::metadata(&locked).unwrap().permissions().mode() & 0o700,
            0o700
        );
        assert_eq!(fs::read(locked.join("f.txt")).unwrap(), b"hi");
        let mode = fs::metadata(dest.path().join("files/run.sh"))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o7000, 0, "no setuid/setgid/sticky: {mode:o}");
        assert_eq!(mode & 0o111, 0, "not executable: {mode:o}");
    }

    fn assert_not_archive(path: &Path) {
        let dest = tempfile::tempdir().unwrap();
        let err = extract_archive(path, dest.path()).unwrap_err();
        assert!(matches!(err, GroveError::InvalidData(_)), "{err:?}");
        assert!(
            err.to_string().starts_with("not a valid Grove archive"),
            "{err}"
        );
    }

    #[test]
    fn extract_rejects_non_archives() {
        let dir = tempfile::tempdir().unwrap();
        let empty = dir.path().join("empty.tar.gz");
        fs::write(&empty, b"").unwrap();
        assert_not_archive(&empty);

        let text = dir.path().join("text.tar.gz");
        fs::write(&text, b"this is not gzip at all").unwrap();
        assert_not_archive(&text);

        let good = dir.path().join("good.tar.gz");
        let mut tables = BTreeMap::new();
        let mut row = Row::new();
        row.insert("k".into(), "v".repeat(10_000).into());
        tables.insert("tasks".to_string(), vec![row]);
        write_archive(&good, b"{}", &tables, &[]).unwrap();
        let bytes = fs::read(&good).unwrap();
        let truncated = dir.path().join("truncated.tar.gz");
        fs::write(&truncated, &bytes[..bytes.len() / 2]).unwrap();
        assert_not_archive(&truncated);
    }
}

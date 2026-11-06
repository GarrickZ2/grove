//! Zip download of Studio task artifacts: a folder, or a selected set of
//! files and folders, from one of the task's `input/` / `output/` roots.

use crate::platform::CanonicalPath;
use std::collections::HashSet;
use std::io::{Seek, SeekFrom, Write};
use std::path::{Component, Path as FsPath, PathBuf};

use axum::{
    body::Body,
    extract::{Path, Query},
    http::{header, StatusCode},
    response::Response,
    Json,
};
use tokio_util::io::ReaderStream;

use crate::api::error::ApiError;
use crate::storage::workspace;

use super::super::common::find_project_by_id;
use super::super::studio_common;

/// Most files one archive may hold.
pub(crate) const MAX_ZIP_FILES: usize = 20_000;
/// Most uncompressed bytes one archive may hold (2 GiB keeps it zip32).
pub(crate) const MAX_ZIP_BYTES: u64 = 2 * 1024 * 1024 * 1024;
/// Most paths one request may select.
const MAX_ZIP_SELECTION: usize = 5_000;

type ApiErr = (StatusCode, Json<ApiError>);

fn err(status: StatusCode, message: impl Into<String>) -> ApiErr {
    (
        status,
        Json(ApiError {
            error: message.into(),
        }),
    )
}

#[derive(serde::Deserialize)]
pub struct ArtifactZipQuery {
    /// `input` or `output`.
    pub dir: String,
    /// One file or folder, relative to `dir`; empty or absent zips the whole root.
    pub path: Option<String>,
    /// A JSON array of paths relative to `dir` (a multi-selection). Takes
    /// precedence over `path`.
    pub paths: Option<String>,
    /// Archive file name (without or with `.zip`).
    pub name: Option<String>,
}

/// One file or (empty) folder to write into the archive.
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct ZipItem {
    pub source: PathBuf,
    /// Archive entry name, `/`-separated; folders end with `/`.
    pub name: String,
    pub is_dir: bool,
    pub size: u64,
}

/// Normalise a requested relative path into its components. Rejects
/// absolute paths, `..` and anything that isn't a plain name.
pub(crate) fn safe_components(rel: &str) -> Result<Vec<String>, ApiErr> {
    let trimmed = rel.trim();
    if trimmed.contains('\0') || trimmed.contains('\\') {
        return Err(err(StatusCode::BAD_REQUEST, "Invalid path"));
    }
    let mut parts = Vec::new();
    for component in FsPath::new(trimmed).components() {
        match component {
            Component::Normal(name) => parts.push(name.to_string_lossy().into_owned()),
            Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                return Err(err(StatusCode::BAD_REQUEST, "Invalid path"));
            }
        }
    }
    Ok(parts)
}

/// Longest shared parent folder of the selected paths (component lists).
fn common_parent(selections: &[Vec<String>]) -> Vec<String> {
    let mut iter = selections.iter();
    let Some(first) = iter.next() else {
        return Vec::new();
    };
    // A path's parent is all but its last component.
    let mut prefix: Vec<String> = first[..first.len().saturating_sub(1)].to_vec();
    for parts in iter {
        let parent = &parts[..parts.len().saturating_sub(1)];
        let shared = prefix
            .iter()
            .zip(parent.iter())
            .take_while(|(a, b)| a == b)
            .count();
        prefix.truncate(shared);
    }
    prefix
}

fn is_link(path: &FsPath) -> bool {
    crate::fs_link::is_link(path)
}

/// Resolve the selection under `root` into archive items. Every selected
/// path must exist, stay inside `root` once symlinks are resolved and not be
/// a link itself; links met while walking folders are skipped (linked work
/// directories in `input/` are never followed). Enforces the size limits.
pub(crate) fn collect_zip_items(
    root: &FsPath,
    selection: &[String],
) -> Result<Vec<ZipItem>, ApiErr> {
    let canonical_root = root
        .canonical()
        .map_err(|_| err(StatusCode::NOT_FOUND, "Artifact folder not found"))?;

    let mut selections = Vec::with_capacity(selection.len());
    for rel in selection {
        selections.push(safe_components(rel)?);
    }
    if selections.is_empty() {
        selections.push(Vec::new());
    }
    // Selecting the root alongside anything else is just the root.
    if selections.iter().any(|s| s.is_empty()) {
        selections = vec![Vec::new()];
    }
    let strip = common_parent(&selections);

    let mut items = Vec::new();
    let mut seen = HashSet::new();
    let mut total_bytes: u64 = 0;
    let mut file_count: usize = 0;

    for parts in &selections {
        let target = parts.iter().fold(canonical_root.clone(), |p, c| p.join(c));
        if !parts.is_empty() {
            let meta = std::fs::symlink_metadata(&target)
                .map_err(|_| err(StatusCode::NOT_FOUND, "File not found"))?;
            if meta.file_type().is_symlink() || is_link(&target) {
                return Err(err(StatusCode::FORBIDDEN, "Linked paths can't be zipped"));
            }
        }
        let canonical = target
            .canonical()
            .map_err(|_| err(StatusCode::NOT_FOUND, "File not found"))?;
        if !canonical.starts_with(&canonical_root) {
            return Err(err(StatusCode::FORBIDDEN, "Access denied"));
        }

        let walker = walkdir::WalkDir::new(&canonical)
            .follow_links(false)
            .sort_by_file_name();
        let mut walker = walker.into_iter();
        while let Some(entry) = walker.next() {
            let Ok(entry) = entry else { continue };
            let path = entry.path();
            if entry.file_type().is_symlink() || (entry.depth() > 0 && is_link(path)) {
                if entry.file_type().is_dir() {
                    walker.skip_current_dir();
                }
                continue;
            }
            let Ok(rel_to_root) = path.strip_prefix(&canonical_root) else {
                continue;
            };
            let rel_parts: Vec<String> = rel_to_root
                .components()
                .map(|c| c.as_os_str().to_string_lossy().into_owned())
                .collect();
            if rel_parts.len() < strip.len() || rel_parts[..strip.len()] != strip[..] {
                continue;
            }
            let name_parts = &rel_parts[strip.len()..];
            let is_dir = entry.file_type().is_dir();
            if name_parts.is_empty() {
                // The root itself (whole-folder download) has no entry of its own.
                continue;
            }
            let mut name = name_parts.join("/");
            if is_dir {
                name.push('/');
            }
            if !seen.insert(name.clone()) {
                continue;
            }
            let size = if is_dir {
                0
            } else {
                entry.metadata().map(|m| m.len()).unwrap_or(0)
            };
            if !is_dir {
                file_count += 1;
                total_bytes = total_bytes.saturating_add(size);
                if file_count > MAX_ZIP_FILES {
                    return Err(err(
                        StatusCode::PAYLOAD_TOO_LARGE,
                        format!("Too many files to zip (max {MAX_ZIP_FILES})"),
                    ));
                }
                if total_bytes > MAX_ZIP_BYTES {
                    return Err(err(
                        StatusCode::PAYLOAD_TOO_LARGE,
                        "Selection too large to zip (max 2 GB)",
                    ));
                }
            }
            items.push(ZipItem {
                source: path.to_path_buf(),
                name,
                is_dir,
                size,
            });
        }
    }
    Ok(items)
}

/// Formats that are already compressed — deflating them only burns CPU.
fn already_compressed(name: &str) -> bool {
    const EXTS: &[&str] = &[
        "png", "jpg", "jpeg", "gif", "webp", "avif", "heic", "mp4", "mov", "webm", "mkv", "mp3",
        "m4a", "aac", "ogg", "flac", "zip", "gz", "tgz", "bz2", "xz", "zst", "7z", "rar", "pdf",
        "docx", "xlsx", "pptx", "woff", "woff2",
    ];
    name.rsplit_once('.')
        .map(|(_, ext)| EXTS.contains(&ext.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

fn zip_time(path: &FsPath) -> zip::DateTime {
    use chrono::{Datelike, Timelike};
    let modified = std::fs::metadata(path).and_then(|m| m.modified()).ok();
    modified
        .map(chrono::DateTime::<chrono::Local>::from)
        .and_then(|t| {
            zip::DateTime::from_date_and_time(
                u16::try_from(t.year()).ok()?,
                t.month() as u8,
                t.day() as u8,
                t.hour() as u8,
                t.minute() as u8,
                t.second() as u8,
            )
            .ok()
        })
        .unwrap_or_default()
}

/// Write the items as a zip archive into `out`.
pub(crate) fn write_zip<W: Write + Seek>(items: &[ZipItem], out: W) -> std::io::Result<W> {
    use zip::write::SimpleFileOptions;
    use zip::CompressionMethod;

    let to_io = |e: zip::result::ZipError| std::io::Error::other(e.to_string());
    let mut writer = zip::ZipWriter::new(out);
    for item in items {
        let options = SimpleFileOptions::default().last_modified_time(zip_time(&item.source));
        if item.is_dir {
            writer
                .add_directory(item.name.trim_end_matches('/'), options)
                .map_err(to_io)?;
            continue;
        }
        let method = if already_compressed(&item.name) {
            CompressionMethod::Stored
        } else {
            CompressionMethod::Deflated
        };
        let mut file = match std::fs::File::open(&item.source) {
            Ok(f) => f,
            // Vanished between listing and zipping (agent still writing) — skip it.
            Err(_) => continue,
        };
        writer
            .start_file(item.name.as_str(), options.compression_method(method))
            .map_err(to_io)?;
        std::io::copy(&mut file, &mut writer)?;
    }
    writer.finish().map_err(to_io)
}

/// `Content-Disposition` for an archive name, with an ASCII fallback and an
/// RFC 5987 UTF-8 form for non-ASCII names.
fn attachment_disposition(name: &str) -> String {
    let clean = studio_common::sanitize_filename_for_header(name);
    let ascii: String = clean
        .chars()
        .map(|c| {
            if c.is_ascii() && !c.is_ascii_control() {
                c
            } else {
                '_'
            }
        })
        .collect();
    let encoded: String = clean
        .bytes()
        .map(|b| {
            if b.is_ascii_alphanumeric() || b"-._~".contains(&b) {
                (b as char).to_string()
            } else {
                format!("%{b:02X}")
            }
        })
        .collect();
    format!("attachment; filename=\"{ascii}\"; filename*=UTF-8''{encoded}")
}

fn archive_name(query: &ArtifactZipQuery, selection: &[String]) -> String {
    let requested = query
        .name
        .as_deref()
        .map(str::trim)
        .filter(|n| !n.is_empty())
        .map(|n| n.rsplit(['/', '\\']).next().unwrap_or(n).to_string());
    let base = requested.unwrap_or_else(|| match selection {
        [] => query.dir.clone(),
        [one] => one
            .trim_end_matches('/')
            .rsplit('/')
            .next()
            .filter(|n| !n.is_empty())
            .unwrap_or(&query.dir)
            .to_string(),
        many => format!("{}-{}-items", query.dir, many.len()),
    });
    if base.to_ascii_lowercase().ends_with(".zip") {
        base
    } else {
        format!("{base}.zip")
    }
}

fn resolve_studio_task_dir(id: &str, task_id: &str) -> Result<PathBuf, ApiErr> {
    let (project, project_key) = find_project_by_id(id).map_err(|s| err(s, "Project not found"))?;
    if project.project_type != workspace::ProjectType::Studio {
        return Err(err(
            StatusCode::NOT_FOUND,
            "Artifacts are only available for Studio tasks",
        ));
    }
    super::artifacts::resolve_task_dir(&project, &project_key, task_id)
        .filter(|dir| dir.is_dir())
        .ok_or_else(|| err(StatusCode::NOT_FOUND, "Task not found"))
}

/// GET /api/v1/projects/{id}/tasks/{taskId}/artifacts/zip?dir=output&path=site
/// GET /api/v1/projects/{id}/tasks/{taskId}/artifacts/zip?dir=input&paths=["a.png","docs"]
///
/// Builds the archive in an anonymous temp file (deleted on close), then
/// streams it with a known length.
pub async fn download_artifacts_zip(
    Path((id, task_id)): Path<(String, String)>,
    Query(query): Query<ArtifactZipQuery>,
) -> Result<Response, ApiErr> {
    if query.dir != "input" && query.dir != "output" {
        return Err(err(StatusCode::BAD_REQUEST, "dir must be input or output"));
    }
    let selection: Vec<String> = match (&query.paths, &query.path) {
        (Some(raw), _) => serde_json::from_str(raw).map_err(|_| {
            err(
                StatusCode::BAD_REQUEST,
                "paths must be a JSON array of strings",
            )
        })?,
        (None, Some(one)) if !one.trim().is_empty() => vec![one.clone()],
        _ => Vec::new(),
    };
    if selection.len() > MAX_ZIP_SELECTION {
        return Err(err(
            StatusCode::PAYLOAD_TOO_LARGE,
            format!("Too many paths selected (max {MAX_ZIP_SELECTION})"),
        ));
    }
    let task_dir = resolve_studio_task_dir(&id, &task_id)?;
    let root = task_dir.join(&query.dir);
    let filename = archive_name(&query, &selection);

    let file = tokio::task::spawn_blocking(move || -> Result<std::fs::File, ApiErr> {
        let items = collect_zip_items(&root, &selection)?;
        let tmp = tempfile::tempfile().map_err(|e| {
            err(
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("Failed to create archive: {e}"),
            )
        })?;
        let mut file = write_zip(&items, tmp).map_err(|e| {
            err(
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("Failed to write archive: {e}"),
            )
        })?;
        file.seek(SeekFrom::Start(0)).map_err(|e| {
            err(
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("Failed to read archive: {e}"),
            )
        })?;
        Ok(file)
    })
    .await
    .map_err(|_| err(StatusCode::INTERNAL_SERVER_ERROR, "Archive task failed"))??;

    let length = file.metadata().map(|m| m.len()).unwrap_or(0);
    let body = Body::from_stream(ReaderStream::new(tokio::fs::File::from_std(file)));
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "application/zip")
        .header(
            header::CONTENT_DISPOSITION,
            attachment_disposition(&filename),
        )
        .header(header::CONTENT_LENGTH, length)
        .header(header::CACHE_CONTROL, "no-cache")
        .header("x-content-type-options", "nosniff")
        .body(body)
        .map_err(|e| err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;

    fn setup() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        let out = dir.path().join("output");
        std::fs::create_dir_all(out.join("site/assets")).unwrap();
        std::fs::create_dir_all(out.join("empty")).unwrap();
        std::fs::write(out.join("site/index.html"), "<h1>hi</h1>").unwrap();
        std::fs::write(out.join("site/assets/app.js"), "console.log(1)").unwrap();
        std::fs::write(out.join("report.md"), "# Report").unwrap();
        dir
    }

    fn names(items: &[ZipItem]) -> Vec<&str> {
        items.iter().map(|i| i.name.as_str()).collect()
    }

    #[test]
    fn rejects_traversal_and_absolute_paths() {
        for bad in [
            "../secret",
            "site/../../x",
            "/etc/passwd",
            "a\\..\\b",
            "a\0b",
        ] {
            assert_eq!(
                safe_components(bad).unwrap_err().0,
                StatusCode::BAD_REQUEST,
                "{bad}"
            );
        }
        assert_eq!(
            safe_components("./site/index.html").unwrap(),
            vec!["site", "index.html"]
        );
        assert!(safe_components("").unwrap().is_empty());
    }

    #[test]
    fn folder_selection_keeps_folder_name_as_archive_root() {
        let dir = setup();
        let items = collect_zip_items(&dir.path().join("output"), &["site".into()]).unwrap();
        assert_eq!(
            names(&items),
            vec![
                "site/",
                "site/assets/",
                "site/assets/app.js",
                "site/index.html"
            ]
        );
    }

    #[test]
    fn whole_root_and_multi_selection_are_relative_to_common_parent() {
        let dir = setup();
        let root = dir.path().join("output");
        let all = collect_zip_items(&root, &[]).unwrap();
        assert_eq!(
            names(&all),
            vec![
                "empty/",
                "report.md",
                "site/",
                "site/assets/",
                "site/assets/app.js",
                "site/index.html"
            ]
        );
        let picked = collect_zip_items(
            &root,
            &["site/index.html".into(), "site/assets/app.js".into()],
        )
        .unwrap();
        assert_eq!(names(&picked), vec!["index.html", "assets/app.js"]);
        // A file inside a selected folder isn't written twice.
        let overlap = collect_zip_items(&root, &["site".into(), "site/index.html".into()]).unwrap();
        assert_eq!(
            overlap
                .iter()
                .filter(|i| i.name == "site/index.html")
                .count(),
            1
        );
    }

    #[test]
    fn missing_paths_are_not_found() {
        let dir = setup();
        let e = collect_zip_items(&dir.path().join("output"), &["nope.txt".into()]).unwrap_err();
        assert_eq!(e.0, StatusCode::NOT_FOUND);
    }

    #[cfg(unix)]
    #[test]
    fn symlinks_are_never_followed() {
        let dir = setup();
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("secret.txt"), "secret").unwrap();
        let input = dir.path().join("input");
        std::fs::create_dir_all(&input).unwrap();
        std::fs::write(input.join("mine.txt"), "mine").unwrap();
        std::os::unix::fs::symlink(outside.path(), input.join("linked")).unwrap();
        std::os::unix::fs::symlink(outside.path().join("secret.txt"), input.join("s.txt")).unwrap();

        // Walking the root skips both links.
        let items = collect_zip_items(&input, &[]).unwrap();
        assert_eq!(names(&items), vec!["mine.txt"]);
        // Selecting a link, or a path through one, is refused.
        for bad in ["linked", "s.txt", "linked/secret.txt"] {
            let e = collect_zip_items(&input, &[bad.into()]).unwrap_err();
            assert!(matches!(e.0, StatusCode::FORBIDDEN), "{bad}: {:?}", e.0);
        }
    }

    #[test]
    fn writes_a_readable_archive() {
        let dir = setup();
        let items = collect_zip_items(&dir.path().join("output"), &["site".into()]).unwrap();
        let bytes = write_zip(&items, std::io::Cursor::new(Vec::new()))
            .unwrap()
            .into_inner();
        let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bytes)).unwrap();
        let mut html = String::new();
        archive
            .by_name("site/index.html")
            .unwrap()
            .read_to_string(&mut html)
            .unwrap();
        assert_eq!(html, "<h1>hi</h1>");
        assert!(archive.by_name("site/assets/").unwrap().is_dir());
    }

    #[test]
    fn archive_names() {
        let q = |path: Option<&str>, name: Option<&str>| ArtifactZipQuery {
            dir: "output".into(),
            path: path.map(Into::into),
            paths: None,
            name: name.map(Into::into),
        };
        assert_eq!(archive_name(&q(None, None), &[]), "output.zip");
        assert_eq!(archive_name(&q(None, None), &["a/site".into()]), "site.zip");
        assert_eq!(
            archive_name(&q(None, None), &["a".into(), "b".into()]),
            "output-2-items.zip"
        );
        assert_eq!(
            archive_name(&q(None, Some("../x/My Pack")), &[]),
            "My Pack.zip"
        );
        assert!(attachment_disposition("报告.zip").contains("filename*=UTF-8''%E6%8A%A5"));
    }
}

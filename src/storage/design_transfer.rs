//! Designs in and out of Grove: a zip of plain files, a page as one HTML file.
//!
//! The zip is the layout other design tools write and read: a folder of HTML,
//! CSS and assets. A design goes out as `<design>/…` beside `system/…`, so
//! the pages' `../system/` links hold wherever it is unpacked. The design
//! system on its own goes out as `system/…` alone.

use std::collections::HashSet;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;

use regex::{Captures, Regex};

use super::designs::{self, SYSTEM};
use crate::error::{GroveError, Result};
use crate::platform::CanonicalPath;

/// Most files one archive may hold, either way.
const MAX_FILES: usize = 5000;
/// Most bytes an imported archive may unpack to.
const MAX_IMPORT_BYTES: u64 = 100 * 1024 * 1024;
/// The largest single file an import takes.
const MAX_IMPORT_FILE: u64 = 25 * 1024 * 1024;
/// How much one page may grow to when its files are put inside it.
const MAX_STANDALONE_BYTES: usize = 64 * 1024 * 1024;
const MAX_CSS_IMPORT_DEPTH: usize = 5;

/// The import brought a design system and the Project has one already.
pub const SYSTEM_EXISTS: &str = "the Project already has a design system";

// ─── Export ──────────────────────────────────────────────────────────────────

/// One file to pack: its name in the archive and where it is on disk.
pub struct Packed {
    pub name: String,
    pub source: PathBuf,
    pub size: u64,
}

/// Collect the visible files under `dir`, naming them under `prefix`. Only
/// files that really are inside one of `roots` are taken, so a link an agent
/// made to somewhere else is left out.
fn collect(dir: &Path, prefix: &str, roots: &[PathBuf], out: &mut Vec<Packed>) -> Result<()> {
    for entry in designs::visible_entries(dir) {
        let name = entry.file_name().to_string_lossy().into_owned();
        let Ok(path) = entry.path().canonical() else {
            continue;
        };
        if !roots.iter().any(|root| path.starts_with(root)) {
            continue;
        }
        let Ok(meta) = std::fs::metadata(&path) else {
            continue;
        };
        let relative = format!("{prefix}{name}");
        if meta.is_dir() {
            collect(&path, &format!("{relative}/"), roots, out)?;
        } else if meta.is_file() {
            if out.len() >= MAX_FILES {
                return Err(GroveError::storage("too many files to export"));
            }
            out.push(Packed {
                name: relative,
                source: path,
                size: meta.len(),
            });
        }
    }
    Ok(())
}

/// The files of a design's archive: its own folder, and the design system
/// as `system/` beside it.
pub fn export_files(project: &str, task_id: &str, slug: &str) -> Result<Vec<Packed>> {
    let dir = designs::design_dir(project, task_id, slug)?;
    let root = designs::design_root(project, task_id)?;
    let system = root.join(SYSTEM);
    let roots: Vec<PathBuf> = [root.canonical().ok(), system.canonical().ok()]
        .into_iter()
        .flatten()
        .collect();
    let mut files = Vec::new();
    collect(&dir, &format!("{slug}/"), &roots, &mut files)?;
    if slug != SYSTEM && system.is_dir() {
        collect(&system, "system/", &roots, &mut files)?;
    }
    if files.is_empty() {
        return Err(GroveError::storage(format!("design '{slug}' not found")));
    }
    Ok(files)
}

// ─── A page as one file ──────────────────────────────────────────────────────

static URL_REF: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?i)url\(\s*(?:"([^"]*)"|'([^']*)'|([^'")\s]+))\s*\)"#).unwrap()
});
static CSS_IMPORT: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?i)@import\s+(?:url\(\s*)?["']?([^"')\s;]+)["']?\s*\)?\s*;"#).unwrap()
});
static TAG: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?is)<link\b[^>]*>|<script\b[^>]*>\s*</script\s*>|<(?:img|source|video|audio|input|embed|track)\b[^>]*>",
    )
    .unwrap()
});
static ATTR: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?is)\s([a-z][a-z0-9-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))"#).unwrap()
});

fn percent_decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut at = 0;
    while at < bytes.len() {
        let hex = (bytes[at] == b'%')
            .then(|| text.get(at + 1..at + 3))
            .flatten()
            .and_then(|pair| u8::from_str_radix(pair, 16).ok());
        match hex {
            Some(byte) => {
                out.push(byte);
                at += 3;
            }
            None => {
                out.push(bytes[at]);
                at += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Where a reference written in a file under `base` points, as a path under
/// `design/`. None for anything that is not a file of the design: another
/// site, a data URI, an anchor, a path that leaves `design/`.
fn local_target(base: &str, reference: &str) -> Option<String> {
    let reference = reference.trim();
    let lower = reference.to_ascii_lowercase();
    if reference.is_empty()
        || reference.starts_with(['#', '/', '\\'])
        || lower.contains("://")
        || ["data:", "blob:", "mailto:", "javascript:", "about:", "tel:"]
            .iter()
            .any(|scheme| lower.starts_with(scheme))
    {
        return None;
    }
    let path = reference.split(['?', '#']).next().unwrap_or_default();
    let mut parts: Vec<String> = base
        .split('/')
        .filter(|part| !part.is_empty())
        .map(str::to_string)
        .collect();
    for part in percent_decode(path).split('/') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop()?;
            }
            name => parts.push(name.to_string()),
        }
    }
    (!parts.is_empty()).then(|| parts.join("/"))
}

fn parent(path: &str) -> &str {
    path.rsplit_once('/').map(|(dir, _)| dir).unwrap_or("")
}

/// Puts a page's own files inside it.
struct Inliner<'a> {
    project: &'a str,
    task_id: &'a str,
    /// Bytes added so far; past the limit, references are left as they are.
    added: usize,
}

impl Inliner<'_> {
    fn read(&mut self, base: &str, reference: &str) -> Option<(String, Vec<u8>)> {
        let target = local_target(base, reference)?;
        let file = designs::resolve_file(self.project, self.task_id, &target).ok()?;
        let size = std::fs::metadata(&file).ok()?.len() as usize;
        // A data URI is a third longer than the file.
        if self.added + size + size / 3 > MAX_STANDALONE_BYTES {
            return None;
        }
        let bytes = std::fs::read(&file).ok()?;
        self.added += bytes.len() + bytes.len() / 3;
        Some((target, bytes))
    }

    fn data_uri(&mut self, base: &str, reference: &str) -> Option<String> {
        use base64::Engine;
        let (target, bytes) = self.read(base, reference)?;
        let mime = mime_guess::from_path(&target).first_or_octet_stream();
        Some(format!(
            "data:{mime};base64,{}",
            base64::engine::general_purpose::STANDARD.encode(bytes)
        ))
    }

    /// `url(…)` references to files of the design, as data URIs.
    fn urls(&mut self, base: &str, text: &str) -> String {
        URL_REF
            .replace_all(text, |found: &Captures| {
                let reference = found
                    .get(1)
                    .or(found.get(2))
                    .or(found.get(3))
                    .map_or("", |m| m.as_str());
                match self.data_uri(base, reference) {
                    Some(uri) => format!("url(\"{uri}\")"),
                    None => found[0].to_string(),
                }
            })
            .into_owned()
    }

    /// A stylesheet with what it imports and loads put inside it.
    fn stylesheet(&mut self, path: &str, css: &str, depth: usize) -> String {
        let base = parent(path);
        let merged = CSS_IMPORT
            .replace_all(css, |found: &Captures| {
                if depth >= MAX_CSS_IMPORT_DEPTH {
                    return found[0].to_string();
                }
                match self.read(base, &found[1]) {
                    Some((target, bytes)) => {
                        self.stylesheet(&target, &String::from_utf8_lossy(&bytes), depth + 1)
                    }
                    None => found[0].to_string(),
                }
            })
            .into_owned();
        self.urls(base, &merged)
    }

    fn tag(&mut self, base: &str, tag: &str) -> String {
        let attributes: Vec<(String, String, std::ops::Range<usize>)> = ATTR
            .captures_iter(tag)
            .map(|found| {
                let value = found.get(2).or(found.get(3)).or(found.get(4)).unwrap();
                (
                    found[1].to_ascii_lowercase(),
                    value.as_str().to_string(),
                    found.get(0).unwrap().range(),
                )
            })
            .collect();
        let value = |name: &str| {
            attributes
                .iter()
                .find(|(key, _, _)| key == name)
                .map(|(_, value, _)| value.as_str())
        };
        let lower = tag.to_ascii_lowercase();

        if lower.starts_with("<link") {
            let rel = value("rel").unwrap_or_default().to_ascii_lowercase();
            let Some(href) = value("href") else {
                return tag.to_string();
            };
            if rel.split_whitespace().any(|word| word == "stylesheet") {
                if let Some((target, bytes)) = self.read(base, href) {
                    let css = self.stylesheet(&target, &String::from_utf8_lossy(&bytes), 0);
                    let media = value("media")
                        .map(|media| format!(" media=\"{}\"", media.replace('"', "&quot;")))
                        .unwrap_or_default();
                    return format!(
                        "<style{media}>\n{}\n</style>",
                        css.replace("</style", "<\\/style")
                    );
                }
            } else if rel.contains("icon") {
                return self.with_data_uris(base, tag, &attributes, &["href"]);
            }
            return tag.to_string();
        }

        if lower.starts_with("<script") {
            let Some((_, source, range)) = attributes.iter().find(|(key, _, _)| key == "src")
            else {
                return tag.to_string();
            };
            let Some((_, bytes)) = self.read(base, source) else {
                return tag.to_string();
            };
            let close = lower.find('>').unwrap_or(tag.len());
            let open = format!("{}{}", &tag[..range.start], &tag[range.end..close]);
            let script = String::from_utf8_lossy(&bytes).replace("</script", "<\\/script");
            return format!("{open}>\n{script}\n</script>");
        }

        self.with_data_uris(base, tag, &attributes, &["src", "poster"])
    }

    /// The tag with the named attributes pointing at data URIs.
    fn with_data_uris(
        &mut self,
        base: &str,
        tag: &str,
        attributes: &[(String, String, std::ops::Range<usize>)],
        names: &[&str],
    ) -> String {
        let mut out = String::with_capacity(tag.len());
        let mut at = 0;
        for (key, value, range) in attributes {
            if !names.contains(&key.as_str()) {
                continue;
            }
            let Some(uri) = self.data_uri(base, value) else {
                continue;
            };
            out.push_str(&tag[at..range.start]);
            out.push_str(&format!(" {key}=\"{uri}\""));
            at = range.end;
        }
        out.push_str(&tag[at..]);
        out
    }
}

/// A page with the design's own files put inside it: stylesheets, scripts,
/// images, fonts. What it loads from other sites stays a link. Links to the
/// design's other pages are left as they are.
pub fn standalone_page(project: &str, task_id: &str, slug: &str, file: &str) -> Result<String> {
    let html = designs::read_page(project, task_id, slug, file)?;
    let mut inliner = Inliner {
        project,
        task_id,
        added: 0,
    };
    // The page's own `<style>` and `style=""` first; the tags after, in one
    // pass, so nothing that was put in is read again.
    let html = inliner.urls(slug, &html);
    Ok(TAG
        .replace_all(&html, |found: &Captures| inliner.tag(slug, &found[0]))
        .into_owned())
}

// ─── Import ──────────────────────────────────────────────────────────────────

/// What to do with a design system the archive brings when the Project has
/// one already.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SystemChoice {
    /// Not decided: the import is refused with [`SYSTEM_EXISTS`].
    Ask,
    /// Keep the Project's.
    Skip,
    /// Replace the Project's with the archive's.
    Overwrite,
}

#[derive(Debug, Default, serde::Serialize)]
pub struct Imported {
    /// The designs that were added, by directory name.
    pub designs: Vec<String>,
    /// `installed`, `replaced`, `kept` (the Project's own was kept) or `none`.
    pub system: &'static str,
}

struct Entry {
    parts: Vec<String>,
    body: Vec<u8>,
}

fn read_archive(bytes: &[u8]) -> Result<Vec<Entry>> {
    let invalid = |_| GroveError::storage("not a zip file");
    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bytes)).map_err(invalid)?;
    let mut entries = Vec::new();
    let mut total = 0u64;
    for index in 0..archive.len() {
        let mut file = archive.by_index(index).map_err(invalid)?;
        let is_link = file
            .unix_mode()
            .is_some_and(|mode| mode & 0o170000 == 0o120000);
        if file.is_dir() || is_link {
            continue;
        }
        let Some(path) = file.enclosed_name() else {
            continue;
        };
        let parts: Vec<String> = path
            .components()
            .map(|part| part.as_os_str().to_string_lossy().into_owned())
            .collect();
        // Hidden files and what macOS adds to an archive are not part of it.
        if parts.is_empty()
            || parts
                .iter()
                .any(|part| part.starts_with('.') || part == "__MACOSX")
        {
            continue;
        }
        if entries.len() >= MAX_FILES {
            return Err(GroveError::storage("the zip has too many files"));
        }
        let mut body = Vec::new();
        (&mut file)
            .take(MAX_IMPORT_FILE + 1)
            .read_to_end(&mut body)
            .map_err(|_| GroveError::storage("the zip could not be read"))?;
        if body.len() as u64 > MAX_IMPORT_FILE {
            return Err(GroveError::storage(format!(
                "a file in the zip is too large: {}",
                parts.join("/")
            )));
        }
        total += body.len() as u64;
        if total > MAX_IMPORT_BYTES {
            return Err(GroveError::storage("the zip is too large"));
        }
        entries.push(Entry { parts, body });
    }
    Ok(entries)
}

fn is_html(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    lower.ends_with(".html") || lower.ends_with(".htm")
}

/// The one folder everything is in, when an archive wraps its content in one.
fn wrapper(entries: &[Entry]) -> Option<String> {
    let first = entries.first()?.parts.first()?.clone();
    entries
        .iter()
        .all(|entry| entry.parts.len() > 1 && entry.parts[0] == first)
        .then_some(first)
}

fn unwrap(entries: &mut [Entry]) {
    for entry in entries {
        entry.parts.remove(0);
    }
}

/// A name Grove takes for a design or a page, made from any text.
fn safe_name(raw: &str, fallback: &str) -> String {
    let mut name = String::new();
    for c in raw.trim().chars() {
        let c = if c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.') {
            c
        } else {
            '-'
        };
        if !(c == '-' && name.ends_with('-')) {
            name.push(c);
        }
    }
    let name: String = name
        .trim_matches(|c| matches!(c, '-' | '.'))
        .chars()
        .take(80)
        .collect();
    if name.is_empty() {
        fallback.to_string()
    } else {
        name
    }
}

/// `name`, or `name-2`, `name-3`… when taken.
fn unused(name: &str, taken: impl Fn(&str) -> bool) -> String {
    if !taken(name) {
        return name.to_string();
    }
    (2..)
        .map(|n| format!("{name}-{n}"))
        .find(|candidate| !taken(candidate))
        .unwrap_or_else(|| name.to_string())
}

/// A design to write: its directory name and its files.
struct Unit {
    name: String,
    files: Vec<Entry>,
}

/// Top-level pages get names Grove can address; other files keep theirs. The
/// pages' links to a page that was renamed follow it.
fn name_pages(files: &mut [Entry]) {
    let fine = |name: &str| {
        !is_html(name)
            || (designs::valid_name(name) && name.to_ascii_lowercase().ends_with(".html"))
    };
    let mut used: HashSet<String> = files
        .iter()
        .filter(|entry| entry.parts.len() == 1 && fine(&entry.parts[0]))
        .map(|entry| entry.parts[0].to_ascii_lowercase())
        .collect();
    let mut renamed: Vec<(String, String)> = Vec::new();
    for entry in files.iter_mut().filter(|entry| entry.parts.len() == 1) {
        let name = entry.parts[0].clone();
        if fine(&name) {
            continue;
        }
        let stem = name
            .rsplit_once('.')
            .map_or(name.as_str(), |(stem, _)| stem);
        let stem = unused(&safe_name(stem, "page"), |candidate| {
            used.contains(&format!("{candidate}.html").to_ascii_lowercase())
        });
        let file = format!("{stem}.html");
        used.insert(file.to_ascii_lowercase());
        renamed.push((name, file.clone()));
        entry.parts[0] = file;
    }
    if renamed.is_empty() {
        return;
    }
    for entry in files
        .iter_mut()
        .filter(|entry| entry.parts.len() == 1 && is_html(&entry.parts[0]))
    {
        let mut html = match String::from_utf8(std::mem::take(&mut entry.body)) {
            Ok(html) => html,
            Err(other) => {
                // Not UTF-8: the page is kept as it came.
                entry.body = other.into_bytes();
                continue;
            }
        };
        for (old, new) in &renamed {
            for written in [old.clone(), old.replace(' ', "%20")] {
                for quote in ['"', '\''] {
                    html = html.replace(
                        &format!("{quote}{written}{quote}"),
                        &format!("{quote}{new}{quote}"),
                    );
                }
            }
        }
        entry.body = html.into_bytes();
    }
}

fn write_files(dir: &Path, files: &[Entry]) -> Result<()> {
    for entry in files {
        let path = entry
            .parts
            .iter()
            .fold(dir.to_path_buf(), |path, part| path.join(part));
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(path, &entry.body)?;
    }
    Ok(())
}

/// Make `dir` hold exactly `files`. The new directory is written beside it
/// and swapped in, so a write that fails leaves what was there. The tasks'
/// links to `dir` go by its path and keep working.
fn replace_dir(dir: &Path, files: &[Entry]) -> Result<()> {
    let tag = uuid::Uuid::new_v4().simple().to_string();
    let beside = |kind: &str| {
        let name = dir.file_name().unwrap_or_default().to_string_lossy();
        dir.with_file_name(format!(".{name}.{kind}-{tag}"))
    };
    let (staging, old) = (beside("new"), beside("old"));
    if let Err(error) = write_files(&staging, files) {
        let _ = std::fs::remove_dir_all(&staging);
        return Err(error);
    }
    let had = dir.exists();
    let swapped = (|| -> std::io::Result<()> {
        if had {
            std::fs::rename(dir, &old)?;
        }
        if let Err(error) = std::fs::rename(&staging, dir) {
            if had {
                let _ = std::fs::rename(&old, dir);
            }
            return Err(error);
        }
        Ok(())
    })();
    if let Err(error) = swapped {
        let _ = std::fs::remove_dir_all(&staging);
        return Err(error.into());
    }
    let _ = std::fs::remove_dir_all(&old);
    Ok(())
}

/// What an archive holds: the design system's files and the designs.
fn sort(mut entries: Vec<Entry>, archive_name: &str) -> (Vec<Entry>, Vec<Unit>) {
    let base = archive_name
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(archive_name);
    let base = if base.to_ascii_lowercase().ends_with(".zip") {
        &base[..base.len() - 4]
    } else {
        base
    };
    let mut fallback = safe_name(base, "design");
    let mut all_system = false;
    if let Some(folder) = wrapper(&entries) {
        unwrap(&mut entries);
        all_system = folder == SYSTEM;
        fallback = safe_name(&folder, &fallback);
    }

    let at_top = |name: &str| entries.iter().any(|entry| entry.parts == [name]);
    if all_system || at_top("DESIGN.md") {
        return (entries, Vec::new());
    }
    let (mut system, mut rest): (Vec<Entry>, Vec<Entry>) = entries
        .into_iter()
        .partition(|entry| entry.parts.len() > 1 && entry.parts[0] == SYSTEM);
    unwrap(&mut system);

    let mut units = Vec::new();
    if rest
        .iter()
        .any(|entry| entry.parts.len() == 1 && is_html(&entry.parts[0]))
    {
        units.push(Unit {
            name: fallback,
            files: rest,
        });
        return (system, units);
    }
    let mut folders: Vec<String> = Vec::new();
    for entry in &rest {
        if entry.parts.len() == 2 && is_html(&entry.parts[1]) && !folders.contains(&entry.parts[0])
        {
            folders.push(entry.parts[0].clone());
        }
    }
    for folder in folders {
        let (mut files, others): (Vec<Entry>, Vec<Entry>) =
            rest.into_iter().partition(|entry| entry.parts[0] == folder);
        rest = others;
        unwrap(&mut files);
        units.push(Unit {
            name: safe_name(&folder, "design"),
            files,
        });
    }
    (system, units)
}

/// Bring a zip into the task. It is read as one of:
/// - a design system: everything in a `system` folder, or `DESIGN.md` at the
///   top (another tool's package);
/// - a design: HTML pages at the top, with `system/` beside them when it
///   came from Grove;
/// - several designs: folders that each hold HTML pages.
///
/// A folder that wraps everything is looked through. Designs are always
/// added under a name that is free; the design system follows `choice`.
pub fn import_zip(
    project: &str,
    task_id: &str,
    archive_name: &str,
    bytes: &[u8],
    choice: SystemChoice,
) -> Result<Imported> {
    let entries = read_archive(bytes)?;
    if entries.is_empty() {
        return Err(GroveError::storage("the zip has no files"));
    }
    let (system, units) = sort(entries, archive_name);
    if units.is_empty() && system.is_empty() {
        return Err(GroveError::storage(
            "the zip has no HTML page at its top level or one folder down",
        ));
    }

    let root = designs::ensure_root(project, task_id)?;
    let system_dir = designs::project_system_dir(project)?
        .ok_or_else(|| GroveError::storage("designs are part of Studio tasks"))?;
    let has_system = !designs::visible_entries(&system_dir).is_empty();
    let system_outcome = match (system.is_empty(), has_system, choice) {
        (true, _, _) => "none",
        (false, false, _) => "installed",
        (false, true, SystemChoice::Ask) => return Err(GroveError::storage(SYSTEM_EXISTS)),
        (false, true, SystemChoice::Skip) => "kept",
        (false, true, SystemChoice::Overwrite) => "replaced",
    };

    let mut imported = Imported {
        designs: Vec::new(),
        system: system_outcome,
    };
    if matches!(system_outcome, "installed" | "replaced") {
        replace_dir(&system_dir, &system)?;
    }
    for mut unit in units {
        name_pages(&mut unit.files);
        let name = unused(&unit.name, |candidate| {
            candidate == SYSTEM || !designs::valid_name(candidate) || root.join(candidate).exists()
        });
        // Written beside its place and moved in, so the board never shows half of it.
        let staging = root.join(format!(".import-{}", uuid::Uuid::new_v4().simple()));
        let written = write_files(&staging, &unit.files)
            .and_then(|()| Ok(std::fs::rename(&staging, root.join(&name))?));
        if let Err(error) = written {
            let _ = std::fs::remove_dir_all(&staging);
            return Err(error);
        }
        imported.designs.push(name);
    }
    Ok(imported)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(path: &str) -> Entry {
        Entry {
            parts: path.split('/').map(str::to_string).collect(),
            body: Vec::new(),
        }
    }

    #[test]
    fn references_resolve_inside_the_design_folder() {
        assert_eq!(
            local_target("shop", "assets/a.png").as_deref(),
            Some("shop/assets/a.png")
        );
        assert_eq!(
            local_target("shop", "../system/tokens.css?v=2#x").as_deref(),
            Some("system/tokens.css")
        );
        assert_eq!(
            local_target("shop/css", "./../img/My%20Logo.svg").as_deref(),
            Some("shop/img/My Logo.svg")
        );
        assert_eq!(local_target("shop", "../../notes.md"), None);
        for other in [
            "https://a.b/c.css",
            "//a.b/c.css",
            "data:image/png;base64,AA",
            "#top",
            "/abs.css",
            "",
        ] {
            assert_eq!(local_target("shop", other), None, "{other}");
        }
    }

    #[test]
    fn names_are_made_addressable() {
        assert_eq!(safe_name("Landing Page (v2)", "x"), "Landing-Page-v2");
        assert_eq!(safe_name("  ..  ", "design"), "design");
        assert_eq!(safe_name("设计", "design"), "design");
        let mut files = vec![
            entry("Home Page.html"),
            entry("Home-Page.html"),
            entry("app.css"),
            entry("sub/Other Page.html"),
        ];
        files[1].body = br#"<a href="Home Page.html">a</a><a href='Home%20Page.html'>b</a><a href="Home-Page.html">c</a>"#.to_vec();
        name_pages(&mut files);
        let names: Vec<String> = files.iter().map(|file| file.parts.join("/")).collect();
        assert_eq!(
            names,
            [
                "Home-Page-2.html",
                "Home-Page.html",
                "app.css",
                "sub/Other Page.html"
            ]
        );
        assert_eq!(
            String::from_utf8_lossy(&files[1].body),
            r#"<a href="Home-Page-2.html">a</a><a href='Home-Page-2.html'>b</a><a href="Home-Page.html">c</a>"#
        );
    }

    #[test]
    fn a_wrapping_folder_is_seen() {
        assert_eq!(
            wrapper(&[entry("Export/index.html"), entry("Export/a/b.css")]).as_deref(),
            Some("Export")
        );
        assert_eq!(
            wrapper(&[entry("shop/index.html"), entry("system/tokens.css")]),
            None
        );
        assert_eq!(wrapper(&[entry("index.html"), entry("a/b.css")]), None);
    }

    fn sorted(paths: &[&str], archive: &str) -> (Vec<String>, Vec<(String, Vec<String>)>) {
        let (system, units) = sort(paths.iter().map(|path| entry(path)).collect(), archive);
        let names = |files: &[Entry]| files.iter().map(|file| file.parts.join("/")).collect();
        (
            names(&system),
            units
                .iter()
                .map(|unit| (unit.name.clone(), names(&unit.files)))
                .collect(),
        )
    }

    #[test]
    fn an_archive_is_read_by_what_it_holds() {
        // Grove's own: a design beside the design system.
        let (system, units) = sorted(
            &["shop/home.html", "shop/assets/a.png", "system/tokens.css"],
            "shop.zip",
        );
        assert_eq!(system, ["tokens.css"]);
        assert_eq!(
            units,
            [(
                "shop".to_string(),
                vec!["home.html".to_string(), "assets/a.png".to_string()]
            )]
        );
        // Another tool's: pages at the top, named after the file.
        let (system, units) = sorted(&["index.html", "app.jsx"], "My Export.ZIP");
        assert!(system.is_empty());
        assert_eq!(units[0].0, "My-Export");
        // The same in a wrapping folder.
        let (_, units) = sorted(&["Landing/index.html", "Landing/css/a.css"], "x.zip");
        assert_eq!(
            units,
            [(
                "Landing".to_string(),
                vec!["index.html".to_string(), "css/a.css".to_string()]
            )]
        );
        // A design system, at the top or in its folder.
        for paths in [
            ["DESIGN.md", "tokens.css", "components.html"],
            ["acme/DESIGN.md", "acme/tokens.css", "acme/components.html"],
            ["system/tokens.html", "system/tokens.css", "system/a.css"],
        ] {
            let (system, units) = sorted(&paths, "x.zip");
            assert_eq!(system.len(), 3, "{paths:?}");
            assert!(units.is_empty(), "{paths:?}");
        }
        // Nothing to show.
        let (system, units) = sorted(&["a/b/deep.html", "readme.txt"], "x.zip");
        assert!(system.is_empty() && units.is_empty());
    }

    #[test]
    fn a_page_that_is_not_utf8_is_kept() {
        let mut files = vec![entry("My Page.html"), entry("old.html")];
        files[1].body = vec![b'<', 0xC4, 0xE3, b'>'];
        name_pages(&mut files);
        assert_eq!(files[1].body, [b'<', 0xC4, 0xE3, b'>']);
    }

    #[test]
    fn a_directory_is_replaced_whole_or_not_at_all() {
        let home = tempfile::tempdir().unwrap();
        let dir = home.path().join("design-system");
        std::fs::create_dir_all(dir.join(".preview")).unwrap();
        std::fs::write(dir.join("old.css"), "old").unwrap();
        let mut new = entry("sub/tokens.css");
        new.body = b"new".to_vec();
        replace_dir(&dir, &[new]).unwrap();
        assert_eq!(
            std::fs::read_to_string(dir.join("sub/tokens.css")).unwrap(),
            "new"
        );
        assert!(!dir.join("old.css").exists() && !dir.join(".preview").exists());
        // A file that cannot be written: what was there stays.
        let mut clash = entry("sub/tokens.css/inside.css");
        clash.body = b"x".to_vec();
        let mut first = entry("sub/tokens.css");
        first.body = b"y".to_vec();
        assert!(replace_dir(&dir, &[first, clash]).is_err());
        assert_eq!(
            std::fs::read_to_string(dir.join("sub/tokens.css")).unwrap(),
            "new"
        );
        let left: Vec<_> = std::fs::read_dir(home.path())
            .unwrap()
            .flatten()
            .map(|e| e.file_name())
            .collect();
        assert_eq!(left, ["design-system"]);
    }
}

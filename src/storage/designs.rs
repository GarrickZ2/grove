//! Storage for Studio task designs: HTML pages laid out as artboards.
//!
//! Layout on disk, per task:
//!   <task-workdir>/design/
//!     ├── system/               link to the Project's design system
//!     ├── .viewer               touched while a Grove window shows the Design panel
//!     └── <design>/
//!         ├── design.json       where each page sits on the board, and free labels
//!         ├── <page>.html
//!         ├── assets/…
//!         └── .preview/         what Grove's UI last rendered: <page>.png, <page>.json
//!
//! The agent writes pages and `design.json` with its own file tools. Grove
//! reads them, and writes `design.json` only when the user moves something or
//! a page's rendered height is measured. Both sides edit the same file.

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};

use crate::error::{GroveError, Result};
use crate::platform::CanonicalPath;
use crate::storage::{tasks, workspace};

/// The design system's directory name under `design/`.
pub const SYSTEM: &str = "system";
const LAYOUT_FILE: &str = "design.json";
const PREVIEW_DIR: &str = ".preview";
const VIEWER_FILE: &str = ".viewer";
const DEFAULT_WIDTH: f64 = 1440.0;
const DEFAULT_HEIGHT: f64 = 900.0;
/// The smallest page: what a frame the user draws is held to, and below which
/// a size in `design.json` is taken as a mistake.
const MIN_WIDTH: f64 = 120.0;
const MIN_HEIGHT: f64 = 80.0;
/// Space between pages Grove places itself.
const GAP: f64 = 120.0;
/// Files looked at when working out whether a render is current.
const VERSION_FILE_CAP: usize = 4000;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Page {
    pub file: String,
    pub title: String,
    pub x: f64,
    pub y: f64,
    /// The viewport the page is designed for.
    pub width: f64,
    pub height: f64,
    /// How tall the page came out when Grove's UI rendered it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rendered_height: Option<f64>,
    /// False when `design.json` gives no position and Grove placed the page.
    pub placed: bool,
    /// Changes when the page, its design's files or the design system change.
    pub version: String,
    /// The `version` the stored render was made from.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub capture_version: Option<String>,
}

impl Page {
    /// The height the artboard takes on the board.
    pub fn board_height(&self) -> f64 {
        self.rendered_height.unwrap_or(0.0).max(self.height)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Label {
    pub text: String,
    pub x: f64,
    pub y: f64,
    /// "title" or "subtitle".
    pub size: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Design {
    pub slug: String,
    pub name: String,
    pub is_system: bool,
    pub pages: Vec<Page>,
    pub labels: Vec<Label>,
    /// What the user drew or wrote on the board: notes, text, shapes, pen
    /// strokes. Kept as the panel wrote them.
    #[serde(default)]
    pub marks: Vec<Value>,
    /// The design system's DESIGN.md, when this is the design system.
    pub has_guide: bool,
    /// Problems in `design.json` or the layout, in plain sentences.
    pub warnings: Vec<String>,
}

/// A stored render of one page.
pub struct Capture {
    pub version: String,
    pub png: Option<Vec<u8>>,
    pub report: Value,
}

/// A directory or page name: letters, digits, `-`, `_`, `.`, not hidden.
pub fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 96
        && !name.starts_with('.')
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
}

fn valid_page(file: &str) -> bool {
    valid_name(file) && file.to_ascii_lowercase().ends_with(".html")
}

fn check_names(slug: &str, file: Option<&str>) -> Result<()> {
    if !valid_name(slug) {
        return Err(GroveError::storage("invalid design name"));
    }
    if file.is_some_and(|file| !valid_page(file)) {
        return Err(GroveError::storage("invalid page name"));
    }
    Ok(())
}

fn task_workdir(project: &str, task_id: &str) -> Result<PathBuf> {
    let task =
        tasks::get_task(project, task_id)?.ok_or_else(|| GroveError::storage("task not found"))?;
    Ok(PathBuf::from(task.worktree_path))
}

/// `<task-workdir>/design`, not created.
pub fn design_root(project: &str, task_id: &str) -> Result<PathBuf> {
    Ok(task_workdir(project, task_id)?.join("design"))
}

/// The Project's design system directory, for Studio Projects.
pub(super) fn project_system_dir(project: &str) -> Result<Option<PathBuf>> {
    Ok(workspace::load_project_by_hash(project)?
        .filter(|found| found.project_type == workspace::ProjectType::Studio)
        .map(|found| workspace::studio_project_dir(&found.path).join("design-system")))
}

/// Make `design/` and its `system` link to the Project's design system. The
/// design system directory starts empty; an empty one means "none yet".
pub fn ensure_root(project: &str, task_id: &str) -> Result<PathBuf> {
    let root = design_root(project, task_id)?;
    std::fs::create_dir_all(&root)?;
    if let Some(system) = project_system_dir(project)? {
        std::fs::create_dir_all(&system)?;
        let link = root.join(SYSTEM);
        if std::fs::symlink_metadata(&link).is_err() {
            crate::fs_link::create_link(&system, &link)?;
        }
    }
    Ok(root)
}

fn number(value: Option<&Value>) -> Option<f64> {
    value.and_then(Value::as_f64).filter(|n| n.is_finite())
}

pub(super) fn visible_entries(dir: &Path) -> Vec<std::fs::DirEntry> {
    let mut entries: Vec<_> = std::fs::read_dir(dir)
        .map(|read| read.flatten().collect())
        .unwrap_or_default();
    entries
        .retain(|entry: &std::fs::DirEntry| !entry.file_name().to_string_lossy().starts_with('.'));
    entries.sort_by_key(|entry| entry.file_name());
    entries
}

fn page_files(dir: &Path) -> Vec<String> {
    visible_entries(dir)
        .into_iter()
        .filter(|entry| entry.path().is_file())
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .filter(|name| valid_page(name))
        .collect()
}

/// `<title>` of a page, from the start of the file.
fn html_title(path: &Path) -> Option<String> {
    use std::io::Read;
    let mut head = vec![0u8; 8192];
    let read = std::fs::File::open(path).ok()?.read(&mut head).ok()?;
    let head = String::from_utf8_lossy(&head[..read]).into_owned();
    let lower = head.to_ascii_lowercase();
    let open = lower.find("<title")?;
    let start = open + lower[open..].find('>')? + 1;
    let end = start + lower[start..].find("</title")?;
    let title = head
        .get(start..end)?
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    (!title.is_empty()).then_some(title)
}

fn stem(file: &str) -> String {
    file.rsplit_once('.')
        .map(|(stem, _)| stem)
        .unwrap_or(file)
        .to_string()
}

/// Files that decide how pages of a design render, as (path, mtime, size).
fn fingerprint(dir: &Path, prefix: &str, out: &mut Vec<(String, u128, u64)>) {
    for entry in visible_entries(dir) {
        if out.len() >= VERSION_FILE_CAP {
            return;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        let path = entry.path();
        let Ok(meta) = std::fs::metadata(&path) else {
            continue;
        };
        let relative = format!("{prefix}{name}");
        if meta.is_dir() {
            fingerprint(&path, &format!("{relative}/"), out);
        } else if name != LAYOUT_FILE && !name.to_ascii_lowercase().ends_with(".html") {
            let modified = meta
                .modified()
                .ok()
                .and_then(|time| time.duration_since(SystemTime::UNIX_EPOCH).ok())
                .map(|since| since.as_nanos())
                .unwrap_or(0);
            out.push((relative, modified, meta.len()));
        }
    }
}

fn feed(hasher: &mut Sha256, parts: &[(String, u128, u64)]) {
    for (path, modified, size) in parts {
        hasher.update(path.as_bytes());
        hasher.update([0]);
        hasher.update(modified.to_le_bytes());
        hasher.update(size.to_le_bytes());
    }
}

/// Read one design directory. `shared` is what every page of it also depends
/// on: the design system's files, for a design that is not the system itself.
fn read_design(dir: &Path, slug: &str, shared: &[(String, u128, u64)]) -> Design {
    let is_system = slug == SYSTEM;
    let mut warnings = Vec::new();
    let layout: Value = match std::fs::read_to_string(dir.join(LAYOUT_FILE)) {
        Ok(text) if text.trim().is_empty() => Value::Null,
        Ok(text) => serde_json::from_str(&text).unwrap_or_else(|error| {
            warnings.push(format!(
                "{LAYOUT_FILE} is not valid JSON ({error}); pages were placed automatically."
            ));
            Value::Null
        }),
        Err(_) => Value::Null,
    };

    let files = page_files(dir);
    let mut own = Vec::new();
    fingerprint(dir, &format!("{slug}/"), &mut own);
    // What every page of the design depends on, hashed once.
    let mut common = Sha256::new();
    feed(&mut common, shared);
    feed(&mut common, &own);
    let previews = dir.join(PREVIEW_DIR);

    let mut pages: Vec<Page> = Vec::new();
    for entry in layout
        .get("pages")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let Some(file) = entry.get("file").and_then(Value::as_str) else {
            continue;
        };
        if !files.iter().any(|name| name == file) {
            warnings.push(format!("{LAYOUT_FILE} lists {file}, which does not exist."));
            continue;
        }
        if pages.iter().any(|page| page.file == file) {
            continue;
        }
        let position = number(entry.get("x")).zip(number(entry.get("y")));
        pages.push(Page {
            file: file.to_string(),
            title: entry
                .get("title")
                .and_then(Value::as_str)
                .map(str::to_string)
                .or_else(|| html_title(&dir.join(file)))
                .unwrap_or_else(|| stem(file)),
            x: position.map_or(0.0, |(x, _)| x),
            y: position.map_or(0.0, |(_, y)| y),
            width: number(entry.get("width"))
                .filter(|w| *w >= MIN_WIDTH)
                .unwrap_or(DEFAULT_WIDTH),
            height: number(entry.get("height"))
                .filter(|h| *h >= MIN_HEIGHT)
                .unwrap_or(DEFAULT_HEIGHT),
            rendered_height: number(entry.get("rendered_height")).filter(|h| *h > 0.0),
            placed: position.is_some(),
            version: String::new(),
            capture_version: None,
        });
    }
    for file in &files {
        if !pages.iter().any(|page| &page.file == file) {
            pages.push(Page {
                file: file.clone(),
                title: html_title(&dir.join(file)).unwrap_or_else(|| stem(file)),
                x: 0.0,
                y: 0.0,
                width: DEFAULT_WIDTH,
                height: DEFAULT_HEIGHT,
                rendered_height: None,
                placed: false,
                version: String::new(),
                capture_version: None,
            });
        }
    }
    for page in &mut pages {
        let path = dir.join(&page.file);
        let mut hasher = common.clone();
        if let Ok(meta) = std::fs::metadata(&path) {
            let modified = meta
                .modified()
                .ok()
                .and_then(|time| time.duration_since(SystemTime::UNIX_EPOCH).ok())
                .map(|since| since.as_nanos())
                .unwrap_or(0);
            feed(&mut hasher, &[(page.file.clone(), modified, meta.len())]);
        }
        // The viewport is part of how the page renders.
        hasher.update(format!("\0{}x{}", page.width, page.height).as_bytes());
        page.version = hex::encode(&hasher.finalize()[..8]);
        page.capture_version =
            std::fs::read_to_string(previews.join(format!("{}.json", page.file)))
                .ok()
                .and_then(|text| serde_json::from_str::<Value>(&text).ok())
                .and_then(|report| {
                    report
                        .get("version")
                        .and_then(Value::as_str)
                        .map(str::to_string)
                });
    }
    place_unplaced(&mut pages);

    let labels = layout
        .get("labels")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|entry| {
            Some(Label {
                text: entry.get("text").and_then(Value::as_str)?.to_string(),
                x: number(entry.get("x"))?,
                y: number(entry.get("y"))?,
                size: match entry.get("size").and_then(Value::as_str) {
                    Some("subtitle") => "subtitle",
                    _ => "title",
                }
                .to_string(),
            })
        })
        .collect();

    warnings.extend(overlaps(&pages));
    Design {
        slug: slug.to_string(),
        name: layout
            .get("name")
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| {
                if is_system {
                    "Design system".to_string()
                } else {
                    slug.to_string()
                }
            }),
        is_system,
        has_guide: is_system && dir.join("DESIGN.md").is_file(),
        pages,
        labels,
        marks: layout
            .get("marks")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default(),
        warnings,
    }
}

/// Put pages `design.json` gives no position in a row under everything else.
fn place_unplaced(pages: &mut [Page]) {
    let bottom = pages
        .iter()
        .filter(|page| page.placed)
        .map(|page| page.y + page.board_height())
        .fold(f64::NEG_INFINITY, f64::max);
    let left = pages
        .iter()
        .filter(|page| page.placed)
        .map(|page| page.x)
        .fold(f64::INFINITY, f64::min);
    let y = if bottom.is_finite() {
        bottom + GAP * 2.0
    } else {
        0.0
    };
    let mut x = if left.is_finite() { left } else { 0.0 };
    for page in pages.iter_mut().filter(|page| !page.placed) {
        page.x = x;
        page.y = y;
        x += page.width + GAP;
    }
}

/// Pages that sit on top of each other, as sentences.
fn overlaps(pages: &[Page]) -> Vec<String> {
    let mut found = Vec::new();
    for (index, a) in pages.iter().enumerate() {
        for b in &pages[index + 1..] {
            let apart = a.x + a.width <= b.x
                || b.x + b.width <= a.x
                || a.y + a.board_height() <= b.y
                || b.y + b.board_height() <= a.y;
            if !apart {
                found.push(format!("{} and {} overlap on the board.", a.file, b.file));
            }
        }
    }
    found
}

/// The task's designs, the design system first when it has anything in it.
pub fn list_designs(project: &str, task_id: &str) -> Result<Vec<Design>> {
    let root = design_root(project, task_id)?;
    let system_dir = root.join(SYSTEM);
    let shared = system_fingerprint(&system_dir);
    let mut designs = Vec::new();
    designs.extend(read_system(&system_dir));
    for entry in visible_entries(&root) {
        let slug = entry.file_name().to_string_lossy().into_owned();
        if slug == SYSTEM || !valid_name(&slug) || !entry.path().is_dir() {
            continue;
        }
        let design = read_design(&entry.path(), &slug, &shared);
        if !design.pages.is_empty() {
            designs.push(design);
        }
    }
    Ok(designs)
}

/// The design system's files, which every other design's pages depend on.
fn system_fingerprint(system_dir: &Path) -> Vec<(String, u128, u64)> {
    let mut shared = Vec::new();
    if system_dir.is_dir() {
        fingerprint(system_dir, "system/", &mut shared);
    }
    shared
}

/// The design system as a design, when it has anything in it.
fn read_system(system_dir: &Path) -> Option<Design> {
    (system_dir.is_dir() && !visible_entries(system_dir).is_empty())
        .then(|| read_design(system_dir, SYSTEM, &[]))
}

/// One design, read without going through the task's other designs.
pub fn get_design(project: &str, task_id: &str, slug: &str) -> Result<Option<Design>> {
    check_names(slug, None)?;
    let root = design_root(project, task_id)?;
    let system_dir = root.join(SYSTEM);
    if slug == SYSTEM {
        return Ok(read_system(&system_dir));
    }
    let dir = root.join(slug);
    if !dir.is_dir() {
        return Ok(None);
    }
    let design = read_design(&dir, slug, &system_fingerprint(&system_dir));
    Ok((!design.pages.is_empty()).then_some(design))
}

/// The Project's design system, read from the Project itself: no task is
/// needed to look at it. None when the Project has none yet.
pub fn project_system(project: &str) -> Result<Option<Design>> {
    Ok(project_system_dir(project)?.and_then(|dir| read_system(&dir)))
}

/// A page of the Project's design system.
pub fn read_system_page(project: &str, file: &str) -> Result<String> {
    check_names(SYSTEM, Some(file))?;
    let not_found = || GroveError::storage(format!("page '{file}' not found in the design system"));
    let path = resolve_system_file(project, file).map_err(|_| not_found())?;
    std::fs::read_to_string(path).map_err(|_| not_found())
}

/// A file a design system page loads. `relative` is the path under the
/// design system's directory.
pub fn resolve_system_file(project: &str, relative: &str) -> Result<PathBuf> {
    let not_found = || GroveError::storage("file not found");
    if !plain_visible(relative) {
        return Err(not_found());
    }
    let root = project_system_dir(project)?
        .and_then(|dir| dir.canonical().ok())
        .ok_or_else(not_found)?;
    let file = root.join(relative).canonical().map_err(|_| not_found())?;
    if !file.starts_with(&root) || !file.is_file() {
        return Err(not_found());
    }
    Ok(file)
}

/// A relative path of plain, visible names: nothing hidden, no `..`.
fn plain_visible(relative: &str) -> bool {
    !relative.is_empty()
        && Path::new(relative).components().all(|part| match part {
            std::path::Component::Normal(name) => !name.to_string_lossy().starts_with('.'),
            _ => false,
        })
}

pub(super) fn design_dir(project: &str, task_id: &str, slug: &str) -> Result<PathBuf> {
    check_names(slug, None)?;
    let dir = design_root(project, task_id)?.join(slug);
    if !dir.is_dir() {
        return Err(GroveError::storage(format!("design '{slug}' not found")));
    }
    Ok(dir)
}

#[derive(Debug, Clone, Deserialize)]
pub struct PageChange {
    pub file: String,
    #[serde(default)]
    pub x: Option<f64>,
    #[serde(default)]
    pub y: Option<f64>,
    #[serde(default)]
    pub rendered_height: Option<f64>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct LabelChange {
    pub index: usize,
    /// The label's text when it was moved; a label the agent has since
    /// replaced is left alone.
    pub text: String,
    pub x: f64,
    pub y: f64,
}

/// Apply moves and measured heights to `design.json`, keeping everything else
/// in the file as the agent wrote it.
pub fn update_layout(
    project: &str,
    task_id: &str,
    slug: &str,
    pages: &[PageChange],
    labels: &[LabelChange],
) -> Result<()> {
    let dir = design_dir(project, task_id, slug)?;
    let _writing = layout_lock();
    let current = get_design(project, task_id, slug)?
        .ok_or_else(|| GroveError::storage(format!("design '{slug}' not found")))?;
    let path = dir.join(LAYOUT_FILE);
    let mut layout = read_layout(&path)?;
    if apply_changes(&mut layout, &current, pages, labels) {
        write_layout(&path, &layout)?;
    }
    Ok(())
}

fn round(value: f64) -> Value {
    json!(value.round() as i64)
}

fn apply_changes(
    layout: &mut Value,
    current: &Design,
    pages: &[PageChange],
    labels: &[LabelChange],
) -> bool {
    let mut changed = false;
    let root = layout.as_object_mut().expect("layout is an object");
    if !root.get("pages").is_some_and(Value::is_array) {
        root.insert("pages".into(), json!([]));
    }
    for change in pages {
        let Some(page) = current.pages.iter().find(|page| page.file == change.file) else {
            continue;
        };
        let list = root["pages"].as_array_mut().expect("pages is an array");
        let index = list
            .iter()
            .position(|entry| entry.get("file").and_then(Value::as_str) == Some(&change.file));
        let moved = change
            .x
            .zip(change.y)
            .filter(|(x, y)| x.is_finite() && y.is_finite());
        let entry = match index {
            Some(index) => &mut list[index],
            None => {
                // A page the agent has not placed keeps floating until the
                // user puts it somewhere.
                if moved.is_none() {
                    continue;
                }
                list.push(json!({ "file": page.file, "title": page.title }));
                changed = true;
                list.last_mut().expect("just pushed")
            }
        };
        let Some(entry) = entry.as_object_mut() else {
            continue;
        };
        if let Some((x, y)) = moved {
            changed |= set(entry, "x", round(x));
            changed |= set(entry, "y", round(y));
        }
        if let Some(height) = change.rendered_height.filter(|h| h.is_finite() && *h > 0.0) {
            changed |= set(entry, "rendered_height", round(height));
        }
    }
    if let Some(list) = root.get_mut("labels").and_then(Value::as_array_mut) {
        for change in labels {
            let Some(entry) = list.get_mut(change.index).and_then(Value::as_object_mut) else {
                continue;
            };
            if entry.get("text").and_then(Value::as_str) != Some(&change.text)
                || !change.x.is_finite()
                || !change.y.is_finite()
            {
                continue;
            }
            changed |= set(entry, "x", round(change.x));
            changed |= set(entry, "y", round(change.y));
        }
    }
    changed
}

fn set(entry: &mut Map<String, Value>, key: &str, value: Value) -> bool {
    if entry.get(key) == Some(&value) {
        return false;
    }
    entry.insert(key.to_string(), value);
    true
}

/// A page's HTML.
pub fn read_page(project: &str, task_id: &str, slug: &str, file: &str) -> Result<String> {
    let path = page_path(project, task_id, slug, file)?;
    std::fs::read_to_string(&path)
        .map_err(|_| GroveError::storage(format!("page '{file}' not found in design '{slug}'")))
}

/// Where a page is on disk. A page that is a link to somewhere outside
/// `design/` and the design system is not found.
fn page_path(project: &str, task_id: &str, slug: &str, file: &str) -> Result<PathBuf> {
    check_names(slug, Some(file))?;
    resolve_file(project, task_id, &format!("{slug}/{file}"))
        .map_err(|_| GroveError::storage(format!("page '{file}' not found in design '{slug}'")))
}

/// Said when a file is no longer what the panel worked from.
pub const CHANGED_SINCE: &str = "the file changed since it was read";

/// Refuse a write made from an older copy of the file: `expect` is what the
/// panel read, and the agent may have written since.
fn check_unchanged(path: &Path, expect: Option<&str>) -> Result<()> {
    let Some(expect) = expect else {
        return Ok(());
    };
    // A browser drops the byte order mark when it reads the file as text.
    let plain = |text: &str| text.strip_prefix('\u{feff}').unwrap_or(text).to_string();
    let current = std::fs::read_to_string(path)?;
    if plain(&current) == plain(expect) {
        Ok(())
    } else {
        Err(GroveError::storage(CHANGED_SINCE))
    }
}

/// Replace a page's HTML: the user changed it in the Design panel. Only an
/// existing page can be written, so this never creates files. With `expect`,
/// only when the file still holds that.
pub fn write_page(
    project: &str,
    task_id: &str,
    slug: &str,
    file: &str,
    html: &str,
    expect: Option<&str>,
) -> Result<()> {
    let path = page_path(project, task_id, slug, file)?;
    check_unchanged(&path, expect)?;
    write_whole(&path, &format!(".{file}.grove-tmp"), html.as_bytes())
}

/// The most marks a board keeps.
const MAX_MARKS: usize = 500;

/// Held from reading `design.json` to writing it back, so two changes made
/// through Grove at once both land.
fn layout_lock() -> std::sync::MutexGuard<'static, ()> {
    static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// `design.json` to change: an empty object when there is none yet. A file
/// that is there but does not read as an object is an error, since writing
/// over it would lose what the agent put in it.
fn read_layout(path: &Path) -> Result<Value> {
    let text = match std::fs::read_to_string(path) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(json!({})),
        Err(error) => return Err(error.into()),
    };
    if text.trim().is_empty() {
        return Ok(json!({}));
    }
    serde_json::from_str::<Value>(&text)
        .ok()
        .filter(Value::is_object)
        .ok_or_else(|| {
            GroveError::storage(format!(
                "{LAYOUT_FILE} is not valid JSON, so the change was not saved"
            ))
        })
}

/// Write `path` whole: readers see the old file or the new one.
fn write_whole(path: &Path, scratch_name: &str, body: &[u8]) -> Result<()> {
    let scratch = path.with_file_name(scratch_name);
    std::fs::write(&scratch, body)?;
    std::fs::rename(&scratch, path)?;
    Ok(())
}

fn write_layout(path: &Path, layout: &Value) -> Result<()> {
    let mut text = serde_json::to_string_pretty(layout)?;
    text.push('\n');
    write_whole(path, ".design.json.grove-tmp", text.as_bytes())
}

/// Replace the user's marks on a board. Only the panel writes them.
pub fn set_marks(project: &str, task_id: &str, slug: &str, marks: Vec<Value>) -> Result<()> {
    let path = design_dir(project, task_id, slug)?.join(LAYOUT_FILE);
    if marks.len() > MAX_MARKS || marks.iter().any(|mark| !mark.is_object()) {
        return Err(GroveError::storage("invalid marks"));
    }
    let _writing = layout_lock();
    let mut layout = read_layout(&path)?;
    layout["marks"] = Value::Array(marks);
    write_layout(&path, &layout)
}

/// A new, empty page where the user drew a frame. Returns its file name.
pub fn create_page(
    project: &str,
    task_id: &str,
    slug: &str,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<String> {
    let dir = design_dir(project, task_id, slug)?;
    if ![x, y, width, height].iter().all(|value| value.is_finite()) {
        return Err(GroveError::storage("invalid frame"));
    }
    let _writing = layout_lock();
    let path = dir.join(LAYOUT_FILE);
    // Read first: a `design.json` that cannot be changed leaves no stray page.
    let mut layout = read_layout(&path)?;
    let (number, file) = (1..1000)
        .map(|number| (number, format!("untitled-{number}.html")))
        .find(|(_, file)| !dir.join(file).exists())
        .ok_or_else(|| GroveError::storage("too many untitled pages"))?;
    let title = format!("Untitled {number}");
    std::fs::write(
        dir.join(&file),
        format!(
            "<!doctype html>\n<html>\n<head>\n<meta charset=\"utf-8\">\n<title>{title}</title>\n</head>\n<body>\n</body>\n</html>\n"
        ),
    )?;
    if !layout.get("pages").is_some_and(Value::is_array) {
        layout["pages"] = json!([]);
    }
    layout["pages"]
        .as_array_mut()
        .expect("pages is an array")
        .push(json!({
            "file": file,
            "title": title,
            "x": x.round() as i64,
            "y": y.round() as i64,
            "width": width.round().clamp(MIN_WIDTH, 4000.0) as i64,
            "height": height.round().clamp(MIN_HEIGHT, 8000.0) as i64,
        }));
    write_layout(&path, &layout)?;
    Ok(file)
}

/// Replace a stylesheet under `design/`: the user changed a CSS variable in
/// the panel. `relative` is the path under `design/`; the file must exist.
/// With `expect`, only when the file still holds that.
pub fn write_style(
    project: &str,
    task_id: &str,
    relative: &str,
    css: &str,
    expect: Option<&str>,
) -> Result<()> {
    if !relative.to_ascii_lowercase().ends_with(".css") {
        return Err(GroveError::storage("not a stylesheet"));
    }
    let path = resolve_file(project, task_id, relative)?;
    check_unchanged(&path, expect)?;
    let name = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    write_whole(&path, &format!(".{name}.grove-tmp"), css.as_bytes())
}

/// The design system's DESIGN.md.
pub fn read_guide(project: &str, task_id: &str) -> Result<Option<String>> {
    let path = design_root(project, task_id)?
        .join(SYSTEM)
        .join("DESIGN.md");
    Ok(std::fs::read_to_string(path).ok())
}

/// A file a page loads: anything visible under `design/`, the design system
/// included. `relative` is the path under `design/`.
pub fn resolve_file(project: &str, task_id: &str, relative: &str) -> Result<PathBuf> {
    let not_found = || GroveError::storage("file not found");
    if !plain_visible(relative) {
        return Err(not_found());
    }
    let root = design_root(project, task_id)?;
    let file = root.join(relative).canonical().map_err(|_| not_found())?;
    let inside_task = root.canonical().is_ok_and(|root| file.starts_with(root));
    let inside_system = project_system_dir(project)?
        .and_then(|system| system.canonical().ok())
        .is_some_and(|system| file.starts_with(system));
    if !(inside_task || inside_system) || !file.is_file() {
        return Err(not_found());
    }
    Ok(file)
}

fn preview_paths(dir: &Path, file: &str) -> (PathBuf, PathBuf) {
    let previews = dir.join(PREVIEW_DIR);
    (
        previews.join(format!("{file}.png")),
        previews.join(format!("{file}.json")),
    )
}

/// Store what Grove's UI rendered for a page. `report` is the page check; the
/// image is left out when the page could not be drawn.
pub fn save_capture(
    project: &str,
    task_id: &str,
    slug: &str,
    file: &str,
    version: &str,
    png: Option<&[u8]>,
    report: &Value,
) -> Result<()> {
    check_names(slug, Some(file))?;
    let dir = design_dir(project, task_id, slug)?;
    std::fs::create_dir_all(dir.join(PREVIEW_DIR))?;
    let (png_path, report_path) = preview_paths(&dir, file);
    match png {
        Some(bytes) => std::fs::write(&png_path, bytes)?,
        None => {
            let _ = std::fs::remove_file(&png_path);
        }
    }
    let stored = json!({ "version": version, "report": report });
    std::fs::write(report_path, serde_json::to_string(&stored)?)?;
    Ok(())
}

pub fn load_capture(
    project: &str,
    task_id: &str,
    slug: &str,
    file: &str,
) -> Result<Option<Capture>> {
    check_names(slug, Some(file))?;
    let dir = design_dir(project, task_id, slug)?;
    let (png_path, report_path) = preview_paths(&dir, file);
    let Some(stored) = std::fs::read_to_string(report_path)
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
    else {
        return Ok(None);
    };
    Ok(Some(Capture {
        version: stored
            .get("version")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        png: std::fs::read(png_path).ok(),
        report: stored.get("report").cloned().unwrap_or(Value::Null),
    }))
}

/// Note that a Grove window is showing this task's designs right now.
pub fn touch_viewer(project: &str, task_id: &str) -> Result<()> {
    let root = design_root(project, task_id)?;
    if root.is_dir() {
        std::fs::write(root.join(VIEWER_FILE), b"")?;
    }
    Ok(())
}

/// Whether a Grove window showed this task's designs within `within`.
pub fn viewer_recent(project: &str, task_id: &str, within: Duration) -> bool {
    design_root(project, task_id)
        .ok()
        .and_then(|root| std::fs::metadata(root.join(VIEWER_FILE)).ok())
        .and_then(|meta| meta.modified().ok())
        .and_then(|modified| modified.elapsed().ok())
        .is_some_and(|age| age <= within)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(dir: &Path, name: &str, body: &str) {
        std::fs::create_dir_all(dir.join(name).parent().unwrap()).unwrap();
        std::fs::write(dir.join(name), body).unwrap();
    }

    #[test]
    fn names() {
        assert!(valid_name("insight-ui"));
        assert!(valid_name("v2.1_final"));
        assert!(!valid_name(""));
        assert!(!valid_name(".."));
        assert!(!valid_name(".preview"));
        assert!(!valid_name("a/b"));
        assert!(valid_page("overview.html"));
        assert!(!valid_page("overview.css"));
    }

    #[test]
    fn reads_layout_and_places_the_rest() {
        let temp = tempfile::tempdir().unwrap();
        let dir = temp.path();
        write(
            dir,
            "overview.html",
            "<html><head><title> Overview  page </title></head></html>",
        );
        write(dir, "detail.html", "<p>no title</p>");
        write(dir, "extra.html", "");
        write(
            dir,
            LAYOUT_FILE,
            r#"{"name":"Insight","pages":[
                {"file":"overview.html","x":0,"y":0,"width":1280,"height":800,"rendered_height":1600},
                {"file":"detail.html","title":"Detail","x":1400,"y":0},
                {"file":"gone.html","x":0,"y":0}],
              "labels":[{"text":"Insight","x":0,"y":-80},{"text":"lists","x":0,"y":-40,"size":"subtitle"}]}"#,
        );
        let design = read_design(dir, "insight", &[]);
        assert_eq!(design.name, "Insight");
        assert_eq!(design.pages.len(), 3);
        assert_eq!(design.pages[0].title, "Overview page");
        assert_eq!(design.pages[0].board_height(), 1600.0);
        assert_eq!(design.pages[1].title, "Detail");
        assert_eq!(design.pages[1].width, DEFAULT_WIDTH);
        // The page design.json does not mention goes under the placed ones.
        let extra = &design.pages[2];
        assert!(!extra.placed);
        assert_eq!((extra.x, extra.y), (0.0, 1600.0 + GAP * 2.0));
        assert_eq!(design.labels.len(), 2);
        assert_eq!(design.labels[1].size, "subtitle");
        assert!(design.warnings.iter().any(|w| w.contains("gone.html")));
        assert!(!design.warnings.iter().any(|w| w.contains("overlap")));
    }

    #[test]
    fn reports_overlap() {
        let temp = tempfile::tempdir().unwrap();
        write(temp.path(), "a.html", "");
        write(temp.path(), "b.html", "");
        write(
            temp.path(),
            LAYOUT_FILE,
            r#"{"pages":[{"file":"a.html","x":0,"y":0},{"file":"b.html","x":700,"y":100}]}"#,
        );
        let design = read_design(temp.path(), "d", &[]);
        assert_eq!(
            design.warnings,
            vec!["a.html and b.html overlap on the board."]
        );
    }

    #[test]
    fn version_follows_the_page_and_shared_files() {
        let temp = tempfile::tempdir().unwrap();
        let dir = temp.path();
        write(dir, "a.html", "one");
        write(dir, "b.html", "one");
        write(dir, "assets/app.css", "body{}");
        let before = read_design(dir, "d", &[]);
        write(dir, "a.html", "one, longer");
        let after = read_design(dir, "d", &[]);
        assert_ne!(before.pages[0].version, after.pages[0].version);
        assert_eq!(before.pages[1].version, after.pages[1].version);
        write(dir, "assets/app.css", "body{margin:0}");
        let restyled = read_design(dir, "d", &[]);
        assert_ne!(after.pages[1].version, restyled.pages[1].version);
        let shared = vec![("system/tokens.css".to_string(), 1u128, 2u64)];
        assert_ne!(
            restyled.pages[1].version,
            read_design(dir, "d", &shared).pages[1].version
        );
    }

    #[test]
    fn version_follows_the_viewport() {
        let temp = tempfile::tempdir().unwrap();
        write(temp.path(), "a.html", "one");
        let layout = |width: u32| {
            format!(r#"{{"pages":[{{"file":"a.html","x":0,"y":0,"width":{width}}}]}}"#)
        };
        write(temp.path(), LAYOUT_FILE, &layout(1440));
        let desktop = read_design(temp.path(), "d", &[]);
        write(temp.path(), LAYOUT_FILE, &layout(390));
        let phone = read_design(temp.path(), "d", &[]);
        assert_eq!(phone.pages[0].width, 390.0);
        assert_ne!(desktop.pages[0].version, phone.pages[0].version);
        // The smallest frame the user can draw reads back as drawn.
        write(temp.path(), LAYOUT_FILE, &layout(MIN_WIDTH as u32));
        assert_eq!(read_design(temp.path(), "d", &[]).pages[0].width, MIN_WIDTH);
    }

    #[test]
    fn a_broken_layout_is_not_written_over() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join(LAYOUT_FILE);
        assert_eq!(read_layout(&path).unwrap(), json!({}));
        std::fs::write(&path, r#"{"pages":[{"file":"a.html"},]}"#).unwrap();
        assert!(read_layout(&path).is_err());
        std::fs::write(&path, "[]").unwrap();
        assert!(read_layout(&path).is_err());
        write_layout(&path, &json!({ "name": "Kept" })).unwrap();
        assert_eq!(read_layout(&path).unwrap()["name"], "Kept");
        assert!(visible_entries(temp.path()).len() == 1);
    }

    #[test]
    fn a_write_from_an_older_copy_is_refused() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("a.html");
        std::fs::write(&path, "\u{feff}<p>agent</p>").unwrap();
        assert!(check_unchanged(&path, None).is_ok());
        assert!(check_unchanged(&path, Some("<p>agent</p>")).is_ok());
        assert!(check_unchanged(&path, Some("<p>mine</p>")).is_err());
    }

    #[test]
    fn changes_keep_what_the_agent_wrote() {
        let temp = tempfile::tempdir().unwrap();
        write(temp.path(), "a.html", "");
        write(temp.path(), "b.html", "");
        let mut layout = json!({
            "name": "Kept",
            "notes": "agent's own field",
            "pages": [{ "file": "a.html", "x": 0, "y": 0, "width": 1280, "mine": true }],
            "labels": [{ "text": "Top", "x": 0, "y": -80 }],
        });
        std::fs::write(temp.path().join(LAYOUT_FILE), layout.to_string()).unwrap();
        let current = read_design(temp.path(), "d", &[]);
        let changed = apply_changes(
            &mut layout,
            &current,
            &[
                PageChange {
                    file: "a.html".into(),
                    x: Some(40.4),
                    y: Some(10.0),
                    rendered_height: None,
                },
                // Measured, but not placed by anyone yet: stays out of the file.
                PageChange {
                    file: "b.html".into(),
                    x: None,
                    y: None,
                    rendered_height: Some(1200.0),
                },
                PageChange {
                    file: "missing.html".into(),
                    x: Some(1.0),
                    y: Some(1.0),
                    rendered_height: None,
                },
            ],
            &[
                LabelChange {
                    index: 0,
                    text: "Top".into(),
                    x: 5.0,
                    y: -90.0,
                },
                LabelChange {
                    index: 0,
                    text: "Replaced".into(),
                    x: 99.0,
                    y: 99.0,
                },
            ],
        );
        assert!(changed);
        assert_eq!(layout["notes"], "agent's own field");
        assert_eq!(layout["pages"].as_array().unwrap().len(), 1);
        assert_eq!(
            layout["pages"][0],
            json!({ "file": "a.html", "x": 40, "y": 10, "width": 1280, "mine": true })
        );
        assert_eq!(
            layout["labels"][0],
            json!({ "text": "Top", "x": 5, "y": -90 })
        );

        // Dragging the unplaced page adds it.
        let changed = apply_changes(
            &mut layout,
            &current,
            &[PageChange {
                file: "b.html".into(),
                x: Some(1500.0),
                y: Some(0.0),
                rendered_height: Some(1200.0),
            }],
            &[],
        );
        assert!(changed);
        assert_eq!(layout["pages"][1]["file"], "b.html");
        assert_eq!(layout["pages"][1]["rendered_height"], 1200);
        // Nothing new: nothing written.
        assert!(!apply_changes(
            &mut layout,
            &current,
            &[PageChange {
                file: "a.html".into(),
                x: Some(40.0),
                y: Some(10.0),
                rendered_height: None
            }],
            &[]
        ));
    }
}

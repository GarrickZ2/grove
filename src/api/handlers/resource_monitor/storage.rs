//! A single-flight, immutable inventory of ~/.grove. Scans run off the async
//! executor; drilldown pages read the same snapshot without rewalking disk.
use super::Inventory;
use axum::{extract::Query, http::StatusCode, Json};
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    fs::Metadata,
    path::Path,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

#[derive(Clone, Serialize)]
pub struct StorageNode {
    pub id: usize,
    pub name: String,
    pub kind: String,
    pub detail: String,
    pub bytes: u64,
    pub files: u64,
    pub child_count: usize,
    pub shared: bool,
    pub unreadable: bool,
}

struct Entry {
    node: StorageNode,
    children: Vec<usize>,
}

struct Snapshot {
    id: String,
    scanned_at: String,
    finished: Instant,
    entries: Vec<Entry>,
    read_errors: u64,
}

#[derive(Default)]
struct Cache {
    current: Option<Arc<Snapshot>>,
    scanning: bool,
    error: Option<String>,
}

static CACHE: Lazy<Mutex<Cache>> = Lazy::new(|| Mutex::new(Cache::default()));
const CACHE_AGE: Duration = Duration::from_secs(300);

#[derive(Serialize)]
pub struct StorageStatus {
    pub scanning: bool,
    pub error: Option<String>,
    pub scan_id: Option<String>,
    pub scanned_at: Option<String>,
    pub root: Option<StorageNode>,
    pub groups: Vec<StorageNode>,
    pub read_errors: u64,
    pub size_basis: &'static str,
}

fn current_status() -> StorageStatus {
    let cache = CACHE.lock().unwrap();
    let snapshot = cache.current.as_ref();
    StorageStatus {
        scanning: cache.scanning,
        error: cache.error.clone(),
        scan_id: snapshot.map(|s| s.id.clone()),
        scanned_at: snapshot.map(|s| s.scanned_at.clone()),
        root: snapshot.map(|s| s.entries[0].node.clone()),
        groups: snapshot
            .map(|s| {
                s.entries[0]
                    .children
                    .iter()
                    .map(|&id| s.entries[id].node.clone())
                    .collect()
            })
            .unwrap_or_default(),
        read_errors: snapshot.map_or(0, |s| s.read_errors),
        size_basis: if cfg!(unix) { "allocated" } else { "logical" },
    }
}

fn start_scan(force: bool) {
    let mut cache = CACHE.lock().unwrap();
    if cache.scanning
        || (!force
            && (cache.error.is_some()
                || cache
                    .current
                    .as_ref()
                    .is_some_and(|s| s.finished.elapsed() < CACHE_AGE)))
    {
        return;
    }
    cache.scanning = true;
    cache.error = None;
    // Resolve before spawning: test overrides of grove_dir are thread-local.
    let root = crate::storage::grove_dir();
    tokio::spawn(async move {
        let result = tokio::task::spawn_blocking(move || {
            let inventory = Inventory::load().map_err(|e| e.to_string())?;
            scan(&root, &inventory)
        })
        .await;
        let mut cache = CACHE.lock().unwrap();
        cache.scanning = false;
        match result {
            Ok(Ok(snapshot)) => cache.current = Some(Arc::new(snapshot)),
            Ok(Err(error)) => cache.error = Some(error),
            Err(_) => cache.error = Some("Storage scan interrupted. Try refreshing.".into()),
        }
    });
}

pub async fn status() -> Json<StorageStatus> {
    start_scan(false);
    Json(current_status())
}

pub async fn refresh() -> Json<StorageStatus> {
    start_scan(true);
    Json(current_status())
}

#[derive(Deserialize)]
pub struct ChildrenQuery {
    scan_id: String,
    #[serde(default)]
    node_id: usize,
    #[serde(default)]
    offset: usize,
    #[serde(default)]
    query: String,
}

#[derive(Serialize)]
pub struct ChildrenPage {
    pub nodes: Vec<StorageNode>,
    pub total: usize,
}

pub async fn children(
    Query(query): Query<ChildrenQuery>,
) -> Result<Json<ChildrenPage>, StatusCode> {
    let snapshot = CACHE
        .lock()
        .unwrap()
        .current
        .clone()
        .ok_or(StatusCode::CONFLICT)?;
    if snapshot.id != query.scan_id {
        return Err(StatusCode::CONFLICT);
    }
    tokio::task::spawn_blocking(move || page(&snapshot, &query))
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .map(Json)
}

fn page(snapshot: &Snapshot, query: &ChildrenQuery) -> Result<ChildrenPage, StatusCode> {
    let entry = snapshot
        .entries
        .get(query.node_id)
        .ok_or(StatusCode::NOT_FOUND)?;
    let search = query.query.trim().to_lowercase();
    // Iterative traversal also handles deeply nested dependency directories.
    let matches = |id: usize| {
        if search.is_empty() {
            return true;
        }
        let mut pending = vec![id];
        while let Some(next) = pending.pop() {
            let e = &snapshot.entries[next];
            if e.node.name.to_lowercase().contains(&search)
                || e.node.detail.to_lowercase().contains(&search)
            {
                return true;
            }
            pending.extend(e.children.iter().copied());
        }
        false
    };
    let ids: Vec<_> = entry
        .children
        .iter()
        .copied()
        .filter(|id| matches(*id))
        .collect();
    Ok(ChildrenPage {
        total: ids.len(),
        nodes: ids
            .into_iter()
            .skip(query.offset)
            .take(100)
            .map(|id| snapshot.entries[id].node.clone())
            .collect(),
    })
}

fn add(entries: &mut Vec<Entry>, name: String, kind: &str, detail: String) -> usize {
    let id = entries.len();
    entries.push(Entry {
        node: StorageNode {
            id,
            name,
            kind: kind.into(),
            detail,
            bytes: 0,
            files: 0,
            child_count: 0,
            shared: false,
            unreadable: false,
        },
        children: vec![],
    });
    id
}

fn file_bytes(meta: &Metadata) -> u64 {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        meta.blocks().saturating_mul(512)
    }
    #[cfg(not(unix))]
    {
        meta.len()
    }
}

fn file_identity(path: &Path, meta: &Metadata) -> Option<(u64, u64)> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let _ = path;
        (meta.nlink() > 1).then(|| (meta.dev(), meta.ino()))
    }
    #[cfg(windows)]
    {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::Storage::FileSystem::{
            GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
        };
        let _ = meta;
        let file = std::fs::File::open(path).ok()?;
        let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
        if unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut info) } == 0
            || info.nNumberOfLinks <= 1
        {
            return None;
        }
        Some((
            u64::from(info.dwVolumeSerialNumber),
            (u64::from(info.nFileIndexHigh) << 32) | u64::from(info.nFileIndexLow),
        ))
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = (path, meta);
        None
    }
}

fn scan(root: &Path, inventory: &Inventory) -> Result<Snapshot, String> {
    let root = root
        .canonicalize()
        .map_err(|e| format!("Cannot open Grove storage: {e}"))?;
    if !root.is_dir() {
        return Err("Grove storage is not a directory".into());
    }
    let mut entries = vec![];
    add(
        &mut entries,
        "Grove storage".into(),
        "root",
        "~/.grove".into(),
    );
    let mut directories = HashMap::from([(root.clone(), 0)]);
    let mut links: HashMap<(u64, u64), usize> = HashMap::new();
    let mut errors = 0;
    for item in walkdir::WalkDir::new(&root)
        .follow_links(false)
        .sort_by_file_name()
        .min_depth(1)
        .max_open(16)
    {
        let item = match item {
            Ok(item) => item,
            Err(error) => {
                errors += 1;
                if let Some(id) = error.path().and_then(|p| {
                    directories
                        .get(p)
                        .or_else(|| p.parent().and_then(|p| directories.get(p)))
                }) {
                    entries[*id].node.unreadable = true;
                }
                continue;
            }
        };
        let path = item.path();
        let parent = path
            .parent()
            .and_then(|p| directories.get(p))
            .copied()
            .unwrap_or(0);
        let kind = if item.file_type().is_dir() {
            "directory"
        } else if item.file_type().is_symlink() {
            "symlink"
        } else {
            "file"
        };
        let id = add(
            &mut entries,
            item.file_name().to_string_lossy().into_owned(),
            kind,
            path.strip_prefix(&root)
                .unwrap_or(path)
                .to_string_lossy()
                .into_owned(),
        );
        entries[parent].children.push(id);
        match item.metadata() {
            Ok(meta) => {
                if meta.is_dir() {
                    directories.insert(path.to_path_buf(), id);
                } else {
                    entries[id].node.files = 1;
                    if let Some(identity) =
                        meta.is_file().then(|| file_identity(path, &meta)).flatten()
                    {
                        if let Some(&original) = links.get(&identity) {
                            entries[id].node.shared = true;
                            entries[id].node.detail = format!(
                                "{} · counted at {}",
                                entries[id].node.detail, entries[original].node.detail
                            );
                            continue;
                        }
                        links.insert(identity, id);
                    }
                    entries[id].node.bytes = file_bytes(&meta);
                }
            }
            Err(_) => {
                entries[id].node.unreadable = true;
                errors += 1;
            }
        }
    }
    group_databases(&mut entries);
    regroup(&mut entries, inventory);
    // Postorder over the displayed tree (virtual parents may have higher IDs).
    let mut stack = vec![(0, false)];
    while let Some((id, visited)) = stack.pop() {
        if !visited {
            stack.push((id, true));
            stack.extend(entries[id].children.iter().map(|child| (*child, false)));
        } else {
            let mut bytes = 0_u64;
            let mut files = 0_u64;
            let mut unreadable = entries[id].node.unreadable;
            for &child in &entries[id].children {
                bytes = bytes.saturating_add(entries[child].node.bytes);
                files += entries[child].node.files;
                unreadable |= entries[child].node.unreadable;
            }
            if !entries[id].children.is_empty() {
                entries[id].node.bytes = bytes;
                entries[id].node.files = files;
            }
            entries[id].node.unreadable = unreadable;
            entries[id].node.child_count = entries[id].children.len();
            let mut children = std::mem::take(&mut entries[id].children);
            children.sort_by(|&a, &b| {
                entries[b]
                    .node
                    .bytes
                    .cmp(&entries[a].node.bytes)
                    .then_with(|| entries[a].node.name.cmp(&entries[b].node.name))
            });
            entries[id].children = children;
        }
    }
    Ok(Snapshot {
        id: uuid::Uuid::new_v4().to_string(),
        scanned_at: chrono::Utc::now().to_rfc3339(),
        finished: Instant::now(),
        entries,
        read_errors: errors,
    })
}

// Group before project/task remapping and pagination so every view uses the
// same total, including sidecars that would otherwise fall on another page.
fn group_databases(entries: &mut Vec<Entry>) {
    for parent in 0..entries.len() {
        if !matches!(entries[parent].node.kind.as_str(), "root" | "directory") {
            continue;
        }
        let mut databases = HashMap::new();
        for child in std::mem::take(&mut entries[parent].children) {
            let node = &entries[child].node;
            let base = ["-wal", "-shm", "-journal"]
                .iter()
                .find_map(|suffix| node.name.strip_suffix(suffix))
                .unwrap_or(&node.name);
            if node.kind != "file"
                || ![".db", ".sqlite", ".sqlite3"]
                    .iter()
                    .any(|ext| base.ends_with(ext))
            {
                entries[parent].children.push(child);
                continue;
            }
            let base = base.to_owned();
            let database = *databases.entry(base.clone()).or_insert_with(|| {
                let path = if parent == 0 {
                    std::path::PathBuf::from(&base)
                } else {
                    Path::new(&entries[parent].node.detail).join(&base)
                };
                let name = if path == Path::new("grove.db") {
                    "Grove Database".into()
                } else if base == "index.db"
                    && path.parent().and_then(Path::parent) == Some(Path::new("projects"))
                {
                    "Code Index".into()
                } else {
                    format!(
                        "{} Database",
                        Path::new(&base).file_stem().unwrap().to_string_lossy()
                    )
                };
                let id = add(
                    entries,
                    name,
                    "database",
                    path.to_string_lossy().into_owned(),
                );
                entries[parent].children.push(id);
                id
            });
            entries[database].children.push(child);
        }
    }
}

fn regroup(entries: &mut Vec<Entry>, inventory: &Inventory) {
    let roots = std::mem::take(&mut entries[0].children);
    let common = add(
        entries,
        "Shared & other".into(),
        "shared",
        "Database, caches, tools and other Grove files".into(),
    );
    let mut projects = HashMap::new();
    let mut tasks = HashMap::new();
    for container in roots {
        let category = entries[container].node.name.clone();
        if !["projects", "worktrees", "studios"].contains(&category.as_str())
            || entries[container].node.kind != "directory"
        {
            entries[common].children.push(container);
            continue;
        }
        for physical_project in std::mem::take(&mut entries[container].children) {
            if entries[physical_project].node.kind != "directory" {
                entries[common].children.push(physical_project);
                continue;
            }
            let key = entries[physical_project].node.name.clone();
            let project = *projects.entry(key.clone()).or_insert_with(|| {
                let id = add(
                    entries,
                    inventory.project_name(&key),
                    "project",
                    key.clone(),
                );
                entries[0].children.push(id);
                id
            });
            entries[project].node.unreadable |= entries[physical_project].node.unreadable;
            for child in std::mem::take(&mut entries[physical_project].children) {
                let is_tasks = category != "worktrees"
                    && entries[child].node.name == "tasks"
                    && entries[child].node.kind == "directory";
                if is_tasks {
                    entries[project].node.unreadable |= entries[child].node.unreadable;
                }
                let candidates = if is_tasks {
                    std::mem::take(&mut entries[child].children)
                } else {
                    vec![child]
                };
                for candidate in candidates {
                    if (is_tasks || category == "worktrees")
                        && entries[candidate].node.kind == "directory"
                    {
                        let folder = entries[candidate].node.name.clone();
                        let task_key = if category == "worktrees" {
                            inventory
                                .tasks
                                .iter()
                                .find(|((p, _), t)| {
                                    p == &key
                                        && Path::new(&t.worktree)
                                            .file_name()
                                            .is_some_and(|name| name == folder.as_str())
                                })
                                .map(|((_, task), _)| task.clone())
                                .unwrap_or(folder)
                        } else {
                            folder
                        };
                        let task =
                            *tasks
                                .entry((key.clone(), task_key.clone()))
                                .or_insert_with(|| {
                                    let id = add(
                                        entries,
                                        inventory.task_name(&key, &task_key),
                                        "task",
                                        format!("{key}/{task_key}"),
                                    );
                                    entries[project].children.push(id);
                                    id
                                });
                        entries[candidate].node.name = match category.as_str() {
                            "worktrees" => "Worktree",
                            "studios" => "Studio workspace",
                            _ => "Task data",
                        }
                        .into();
                        entries[task].children.push(candidate);
                    } else {
                        entries[project].children.push(candidate);
                    }
                }
            }
        }
        // Preserve a failed/empty container as evidence instead of silently
        // making unreadable storage look like a complete zero-byte inventory.
        if entries[container].node.unreadable {
            entries[common].children.push(container);
        }
    }
    if !entries[common].children.is_empty() {
        entries[0].children.push(common);
    }
}

#[cfg(test)]
mod tests {
    use super::super::{Project, Task};
    use super::*;

    #[test]
    fn groups_database_sidecars_without_changing_totals_or_mixing_directories() {
        let dir = tempfile::tempdir().unwrap();
        let paths = [
            "grove.db",
            "grove.db-wal",
            "grove.db-shm",
            "projects/p/index.db",
            "projects/p/index.db-wal",
            "projects/p/index.db-shm",
            "projects/q/index.db",
            "projects/q/index.db-journal",
            "cache/state.sqlite3-wal",
            "cache/history.sqlite",
            "cache/index.db.backup",
        ];
        let mut expected_bytes = 0;
        for (index, path) in paths.iter().enumerate() {
            let file = dir.path().join(path);
            std::fs::create_dir_all(file.parent().unwrap()).unwrap();
            std::fs::write(&file, vec![1; 4096 * (index + 1)]).unwrap();
            expected_bytes += file_bytes(&std::fs::metadata(file).unwrap());
        }
        std::fs::create_dir_all(dir.path().join("cache/folder.db")).unwrap();
        let snapshot = scan(dir.path(), &Inventory::default()).unwrap();
        assert_eq!(snapshot.entries[0].node.bytes, expected_bytes);
        assert_eq!(snapshot.entries[0].node.files, paths.len() as u64);
        let databases: Vec<_> = snapshot
            .entries
            .iter()
            .filter(|e| e.node.kind == "database")
            .collect();
        assert_eq!(databases.len(), 5);
        for database in &databases {
            assert_eq!(
                database.node.bytes,
                database
                    .children
                    .iter()
                    .map(|&id| snapshot.entries[id].node.bytes)
                    .sum::<u64>()
            );
            assert_eq!(database.node.files, database.children.len() as u64);
        }
        let index = databases
            .iter()
            .find(|e| Path::new(&e.node.detail) == Path::new("projects/p/index.db"))
            .unwrap();
        assert_eq!(index.node.name, "Code Index");
        assert_eq!(index.node.child_count, 3);
        let project = snapshot
            .entries
            .iter()
            .find(|e| e.node.kind == "project" && e.node.detail == "p")
            .unwrap();
        assert_eq!(project.children, vec![index.node.id]);
        let found = page(
            &snapshot,
            &ChildrenQuery {
                scan_id: snapshot.id.clone(),
                node_id: project.node.id,
                offset: 0,
                query: "index.db-wal".into(),
            },
        )
        .unwrap();
        assert_eq!(found.nodes.len(), 1);
        assert_eq!(found.nodes[0].kind, "database");
        let files = page(
            &snapshot,
            &ChildrenQuery {
                scan_id: snapshot.id.clone(),
                node_id: index.node.id,
                offset: 0,
                query: String::new(),
            },
        )
        .unwrap();
        assert_eq!(files.total, 3);
        assert!(files.nodes.iter().all(|node| node.kind == "file"));
        assert_eq!(
            databases
                .iter()
                .find(|e| e.node.detail == "grove.db")
                .unwrap()
                .node
                .name,
            "Grove Database"
        );
        assert!(snapshot
            .entries
            .iter()
            .any(|e| e.node.name == "index.db.backup" && e.node.kind == "file"));
        assert!(snapshot
            .entries
            .iter()
            .any(|e| e.node.name == "folder.db" && e.node.kind == "directory"));
    }

    #[test]
    fn groups_worktrees_studios_history_and_unregistered_data_without_losing_bytes() {
        let dir = tempfile::tempdir().unwrap();
        for path in [
            "projects/p/tasks/t/chats/history.jsonl",
            "worktrees/p/branch/target/build",
            "studios/p/tasks/t/output/art.png",
            "studios/p/resource/shared.png",
            "grove.db",
            "projects/old/tasks/gone/file",
        ] {
            let file = dir.path().join(path);
            std::fs::create_dir_all(file.parent().unwrap()).unwrap();
            std::fs::write(file, vec![1; 6000]).unwrap();
        }
        let inventory = Inventory {
            projects: HashMap::from([(
                "p".into(),
                Project {
                    name: "Project".into(),
                    path: "/external/repo".into(),
                },
            )]),
            tasks: HashMap::from([(
                ("p".into(), "t".into()),
                Task {
                    name: "My task".into(),
                    worktree: "/.grove/worktrees/p/branch".into(),
                },
            )]),
        };
        let s = scan(dir.path(), &inventory).unwrap();
        let root = &s.entries[0];
        assert_eq!(root.node.files, 6);
        assert_eq!(
            root.children
                .iter()
                .map(|&id| s.entries[id].node.bytes)
                .sum::<u64>(),
            root.node.bytes
        );
        let project = root
            .children
            .iter()
            .map(|&id| &s.entries[id])
            .find(|e| e.node.name == "Project")
            .unwrap();
        let task = project
            .children
            .iter()
            .map(|&id| &s.entries[id])
            .find(|e| e.node.kind == "task")
            .unwrap();
        assert_eq!(task.node.name, "My task");
        assert_eq!(task.node.files, 3);
        assert_eq!(task.children.len(), 3);
        let results = page(
            &s,
            &ChildrenQuery {
                scan_id: s.id.clone(),
                node_id: 0,
                offset: 0,
                query: "art.png".into(),
            },
        )
        .unwrap();
        assert_eq!(results.nodes.len(), 1);
        assert_eq!(results.nodes[0].name, "Project");
    }

    #[cfg(unix)]
    #[test]
    fn counts_hard_links_once_and_never_follows_symlinks() {
        let dir = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let source = dir.path().join("a");
        std::fs::write(&source, vec![1; 8000]).unwrap();
        std::fs::hard_link(&source, dir.path().join("b")).unwrap();
        std::fs::write(outside.path().join("secret"), vec![1; 20000]).unwrap();
        std::os::unix::fs::symlink(outside.path(), dir.path().join("external")).unwrap();
        std::os::unix::fs::symlink(dir.path(), dir.path().join("cycle")).unwrap();
        let s = scan(dir.path(), &Inventory::default()).unwrap();
        assert_eq!(s.entries[0].node.files, 4);
        assert_eq!(s.entries.iter().filter(|e| e.node.shared).count(), 1);
        assert!(!s.entries.iter().any(|e| e.node.name == "secret"));
        let expected = file_bytes(&std::fs::metadata(source).unwrap())
            + file_bytes(&std::fs::symlink_metadata(dir.path().join("external")).unwrap())
            + file_bytes(&std::fs::symlink_metadata(dir.path().join("cycle")).unwrap());
        assert_eq!(s.entries[0].node.bytes, expected);
    }

    #[test]
    fn pages_large_directories_without_changing_totals() {
        let dir = tempfile::tempdir().unwrap();
        for n in 0..205 {
            std::fs::write(dir.path().join(format!("file-{n}")), [1]).unwrap();
        }
        let s = scan(dir.path(), &Inventory::default()).unwrap();
        let common = s.entries[0].children[0];
        let result = page(
            &s,
            &ChildrenQuery {
                scan_id: s.id.clone(),
                node_id: common,
                offset: 200,
                query: String::new(),
            },
        )
        .unwrap();
        assert_eq!(result.total, 205);
        assert_eq!(result.nodes.len(), 5);
        assert_eq!(s.entries[0].node.files, 205);
    }
}

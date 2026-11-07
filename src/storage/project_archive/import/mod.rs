//! Import: a project archive → re-keyed, additive merge into this Grove.
//!
//! All rows go in one transaction that starts with the conflict check;
//! files are copied after it commits, never overwriting.

use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::path::{Component, Path, PathBuf};

use rusqlite::{Connection, OptionalExtension, Transaction, TransactionBehavior};
use serde_json::Value as Json;
use walkdir::WalkDir;

use super::archive::{extract_archive, is_project_runtime_file};
use super::tables::{
    insert_row, quote, row_exists, table_columns, table_info, Column, Row, TableSpec, TABLES,
};
use super::{Manifest, FORMAT_VERSION};
use crate::error::{GroveError, Result};
use crate::storage::workspace::{self, ProjectType};
use crate::storage::{database, grove_dir, tasks};

#[derive(Default)]
pub struct ImportOptions {
    pub path: Option<PathBuf>,
    pub name: Option<String>,
    pub dry_run: bool,
    /// Allow adding the archive to a project that is already registered here.
    pub merge: bool,
}

#[derive(Debug, Default)]
pub struct TableCount {
    pub inserted: usize,
    pub skipped: usize,
}

#[derive(Debug, Default)]
pub struct ImportReport {
    pub project_hash: String,
    pub project_name: String,
    pub project_path: String,
    /// The project was newly registered (on a dry run: would be).
    pub registered: bool,
    pub dry_run: bool,
    pub rows: BTreeMap<String, TableCount>,
    /// Archive tables that this Grove cannot store (unknown or absent here).
    pub tables_skipped: Vec<String>,
    pub files_copied: usize,
    pub files_skipped: usize,
    pub tasks_archived: usize,
    pub automations_disabled: usize,
    pub links_dropped: usize,
    /// Archived tasks whose id is already used here by a different task;
    /// they and everything that belongs to them are not imported.
    pub tasks_conflicting: Vec<String>,
}

/// Where the archive lands in this Grove.
struct Target {
    project_type: ProjectType,
    path: String,
    hash: String,
    name: String,
    is_git_repo: bool,
    /// Not registered here yet.
    register: bool,
}

/// Import the project archive at `archive` into this Grove.
pub fn import_project(archive: &Path, opts: &ImportOptions) -> Result<ImportReport> {
    let tmp = tempfile::tempdir()?;
    extract_archive(archive, tmp.path())?;
    let manifest = read_manifest(tmp.path())?;
    let target = resolve_target(&manifest, opts)?;
    // A dry run only previews, so it needs no --merge.
    if !target.register && !opts.merge && !opts.dry_run {
        return Err(GroveError::invalid_data(format!(
            "Project `{}` at {} is already registered in this Grove. \
             Re-run with --merge to add the archived data to it.",
            target.name, target.path
        )));
    }
    let mut tables = read_tables(tmp.path())?;

    let mut report = ImportReport {
        project_hash: target.hash.clone(),
        project_name: target.name.clone(),
        project_path: target.path.clone(),
        registered: target.register,
        dry_run: opts.dry_run,
        ..Default::default()
    };

    let prefixes = path_prefixes(&manifest, &target);
    {
        let conn = database::try_connection()?;
        // IMMEDIATE takes the write lock up front: a deferred transaction
        // that reads first could fail with BUSY_SNAPSHOT once a running
        // Grove server commits in between.
        let tx = Transaction::new_unchecked(&conn, TransactionBehavior::Immediate)?;
        check_conflicts(&tx, &tables, &target.hash)?;
        report.tasks_conflicting = conflicting_task_ids(&tx, &tables, &target.hash)?;
        if target.register {
            workspace::insert_project_row(
                &tx,
                &target.hash,
                &target.name,
                &target.path,
                target.is_git_repo,
                &target.project_type,
            )?;
        }
        let readonly_meta = imported_session_meta(&manifest);
        let rekey = Rekey {
            target: &target,
            prefixes: &prefixes,
            readonly_meta: &readonly_meta,
        };
        import_rows(&tx, &mut tables, &rekey, &mut report)?;
        if opts.dry_run {
            tx.rollback()?;
        } else {
            tx.commit()?;
        }
    }

    let files = tmp.path().join("files");
    let uri_rewrites = history_rewrites(&manifest, &target);
    copy_tree(
        &files.join("project"),
        &grove_dir().join("projects").join(&target.hash),
        true,
        &uri_rewrites,
        opts.dry_run,
        &mut report,
    )?;
    if target.project_type == ProjectType::Studio {
        copy_tree(
            &files.join("studio"),
            &workspace::studio_project_dir(&target.path),
            false,
            &uri_rewrites,
            opts.dry_run,
            &mut report,
        )?;
    }
    if !opts.dry_run {
        finish_registration(&target)?;
    }
    Ok(report)
}

fn read_manifest(dir: &Path) -> Result<Manifest> {
    let bytes = fs::read(dir.join("manifest.json")).map_err(|_| {
        GroveError::invalid_data("not a Grove project archive (manifest.json missing)")
    })?;
    let manifest: Manifest = serde_json::from_slice(&bytes)
        .map_err(|e| GroveError::invalid_data(format!("invalid manifest.json: {e}")))?;
    if manifest.format_version > FORMAT_VERSION {
        return Err(GroveError::invalid_data(format!(
            "archive format version {} was written by a newer Grove (this Grove supports up to {}); upgrade Grove to import it",
            manifest.format_version, FORMAT_VERSION
        )));
    }
    Ok(manifest)
}

fn resolve_target(manifest: &Manifest, opts: &ImportOptions) -> Result<Target> {
    let project_type = match manifest.project.project_type.as_str() {
        "repo" => ProjectType::Repo,
        "studio" => ProjectType::Studio,
        other => {
            return Err(GroveError::invalid_data(format!(
                "unsupported project type `{other}` in archive"
            )))
        }
    };

    let (path, name, is_git_repo) = if project_type == ProjectType::Studio {
        if opts.path.is_some() {
            return Err(GroveError::invalid_data(
                "this archive holds a Studio project, which has no directory; use --name instead of --path",
            ));
        }
        // Trimmed like the create-project API, so "Design " is "Design".
        let name = opts
            .name
            .as_deref()
            .unwrap_or(&manifest.project.name)
            .trim()
            .to_string();
        if name.is_empty() {
            return Err(GroveError::invalid_data("Studio project name is empty"));
        }
        (format!("studio://{name}"), name, false)
    } else {
        let raw = match &opts.path {
            Some(p) => p.clone(),
            None => std::env::current_dir()?,
        };
        if !raw.is_dir() {
            return Err(GroveError::not_found(format!(
                "target directory {} does not exist",
                raw.display()
            )));
        }
        let path = workspace::resolve_project_path(&raw.to_string_lossy())?;
        let is_git = crate::git::repo_root(&path).is_ok();
        if manifest.project.is_git_repo && !is_git {
            return Err(GroveError::invalid_data(format!(
                "`{}` is not a git repository. Pass --path <repo> to choose where to import the project.",
                raw.display()
            )));
        }
        let name = opts
            .name
            .clone()
            .unwrap_or_else(|| manifest.project.name.clone());
        (path, name, is_git)
    };

    let hash = workspace::project_hash(&path);
    let (name, register) = match workspace::load_project_by_hash(&hash)? {
        Some(existing) => {
            if existing.project_type != project_type {
                return Err(GroveError::invalid_data(format!(
                    "{path} is registered as a {} project but the archive holds a {} project",
                    existing.project_type.as_str(),
                    project_type.as_str()
                )));
            }
            (existing.name, false)
        }
        None => (name, true),
    };
    Ok(Target {
        project_type,
        path,
        hash,
        name,
        is_git_repo,
        register,
    })
}

/// `db/<table>.json` → rows. Table names come from file names.
fn read_tables(dir: &Path) -> Result<BTreeMap<String, Vec<Row>>> {
    let mut tables = BTreeMap::new();
    let db = dir.join("db");
    if !db.is_dir() {
        return Ok(tables);
    }
    for entry in fs::read_dir(&db)? {
        let p = entry?.path();
        if p.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let Some(name) = p.file_stem().and_then(|s| s.to_str()) else {
            continue;
        };
        let rows: Vec<Row> = serde_json::from_slice(&fs::read(&p)?)
            .map_err(|e| GroveError::invalid_data(format!("invalid db/{name}.json: {e}")))?;
        tables.insert(name.to_string(), rows);
    }
    Ok(tables)
}

fn path_prefixes(manifest: &Manifest, target: &Target) -> Vec<(String, String)> {
    let old_grove = PathBuf::from(&manifest.grove_dir);
    let new_grove = grove_dir();
    let mut prefixes: Vec<(String, String)> = ["projects", "studios", "worktrees"]
        .iter()
        .map(|d| {
            (
                old_grove
                    .join(d)
                    .join(&manifest.project.hash)
                    .to_string_lossy()
                    .to_string(),
                new_grove
                    .join(d)
                    .join(&target.hash)
                    .to_string_lossy()
                    .to_string(),
            )
        })
        .collect();
    if target.project_type == ProjectType::Repo {
        prefixes.push((manifest.project.path.clone(), target.path.clone()));
    }
    prefixes
}

/// Replace the longest prefix in `prefixes` that `value` starts with at a path
/// component boundary. Values matching no prefix are returned unchanged.
fn rewrite_path(value: &str, prefixes: &[(String, String)]) -> String {
    let mut best: Option<(&str, &str, &str)> = None; // (old, new, rest)
    for (old, new) in prefixes {
        let old_trimmed = if old.len() > 1 {
            old.trim_end_matches(['/', '\\'])
        } else {
            old.as_str()
        };
        if old_trimmed.is_empty() {
            continue;
        }
        let Some(rest) = value.strip_prefix(old_trimmed) else {
            continue;
        };
        if !(rest.is_empty() || rest.starts_with(['/', '\\'])) {
            continue;
        }
        if best.is_none_or(|(b, _, _)| old_trimmed.len() > b.len()) {
            best = Some((old_trimmed, new.as_str(), rest));
        }
    }
    match best {
        Some((_, new, rest)) => {
            let new = if rest.is_empty() || new.len() <= 1 {
                new
            } else {
                new.trim_end_matches(['/', '\\'])
            };
            format!("{new}{rest}")
        }
        None => value.to_string(),
    }
}

/// Tables whose primary key is globally unique (not scoped by project):
/// (table, id column, project column).
const GLOBAL_IDS: &[(&str, &str, &str)] = &[
    ("session", "session_id", "project"),
    ("automations", "id", "project"),
    ("memory_logs", "id", "project_id"),
    ("memory_relations", "id", "project_id"),
];

/// Refuse the import if a globally unique id from the archive already belongs
/// to a different project here (importing a copy into its own Grove).
fn check_conflicts(
    conn: &Connection,
    tables: &BTreeMap<String, Vec<Row>>,
    new_hash: &str,
) -> Result<()> {
    let mut conflicts = Vec::new();
    for (table, id_col, project_col) in GLOBAL_IDS {
        let Some(rows) = tables.get(*table) else {
            continue;
        };
        if table_columns(conn, table)?.is_empty() {
            continue;
        }
        let sql = format!(
            "SELECT {} FROM {} WHERE {} = ?1",
            quote(project_col),
            quote(table),
            quote(id_col)
        );
        let mut stmt = conn.prepare(&sql)?;
        for row in rows {
            let Some(id) = row.get(*id_col).and_then(Json::as_str) else {
                continue;
            };
            let owner: Option<String> = stmt.query_row([id], |r| r.get(0)).optional()?;
            if let Some(owner) = owner {
                if owner != new_hash {
                    conflicts.push(format!("{table} `{id}` (project {owner})"));
                }
            }
        }
    }
    if conflicts.is_empty() {
        return Ok(());
    }
    let n = conflicts.len();
    let mut shown = conflicts.into_iter().take(5).collect::<Vec<_>>().join(", ");
    if n > 5 {
        shown.push_str(&format!(", and {} more", n - 5));
    }
    Err(GroveError::invalid_data(format!(
        "{n} record(s) from this archive already exists in this Grove under another project: {shown}. \
         Importing a copy of a project into the Grove it came from is not supported."
    )))
}

/// Archived tasks (other than the Local Task, which merges by design) whose id
/// this project already uses for a different task. Task ids are slugs of
/// names, so two installs can each have their own task `fix-login`; the
/// creation time tells them apart from an earlier import of the same task.
fn conflicting_task_ids(
    conn: &Connection,
    tables: &BTreeMap<String, Vec<Row>>,
    new_hash: &str,
) -> Result<Vec<String>> {
    let Some(rows) = tables.get("tasks") else {
        return Ok(Vec::new());
    };
    let mut stmt = conn.prepare("SELECT created_at FROM tasks WHERE project = ?1 AND id = ?2")?;
    let mut ids = Vec::new();
    for row in rows {
        let Some(id) = row.get("id").and_then(Json::as_str) else {
            continue;
        };
        if id == tasks::LOCAL_TASK_ID {
            continue;
        }
        let existing: Option<String> = stmt
            .query_row(rusqlite::params![new_hash, id], |r| r.get(0))
            .optional()?;
        if existing.is_some_and(|c| row.get("created_at").and_then(Json::as_str) != Some(&c)) {
            ids.push(id.to_string());
        }
    }
    ids.sort_unstable();
    ids.dedup();
    Ok(ids)
}

/// True if `rel` (under the project or Studio dir) holds files of one of the
/// tasks `ids`: its task dir, or its note in the project dir.
fn is_task_file(rel: &Path, ids: &[String], project_root: bool) -> bool {
    let mut parts = rel.components().map(|c| c.as_os_str().to_string_lossy());
    match (parts.next().as_deref(), parts.next()) {
        (Some("tasks"), Some(id)) => ids.iter().any(|t| *t == id),
        (Some("notes"), Some(file)) if project_root => file
            .strip_suffix(".md")
            .is_some_and(|id| ids.iter().any(|t| t == id)),
        _ => false,
    }
}

/// An INTEGER flag column of an archive row (the codec writes integers).
fn flag(row: &Row, col: &str) -> bool {
    row.get(col).and_then(Json::as_i64).is_some_and(|n| n != 0)
}

/// Automation ids that keep their enabled state: the archive's Memory
/// organizer, unless this project already has a Memory config pointing elsewhere.
fn organizer_ids(
    conn: &Connection,
    tables: &BTreeMap<String, Vec<Row>>,
    new_hash: &str,
) -> Result<HashSet<String>> {
    let mut ids: HashSet<String> = tables
        .get("memory_project_configs")
        .into_iter()
        .flatten()
        .filter_map(|r| r.get("organization_automation_id").and_then(Json::as_str))
        .map(str::to_string)
        .collect();
    if !table_columns(conn, "memory_project_configs")?.is_empty() {
        let existing: Option<String> = conn
            .query_row(
                "SELECT organization_automation_id FROM memory_project_configs WHERE project_id = ?1",
                [new_hash],
                |r| r.get(0),
            )
            .optional()?;
        if let Some(existing) = existing {
            ids.retain(|id| *id == existing);
        }
    }
    Ok(ids)
}

fn project_exists(conn: &Connection, hash: &str) -> Result<bool> {
    Ok(conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM projects WHERE hash = ?1)",
        [hash],
        |r| r.get(0),
    )?)
}

fn is_constraint_violation(e: &GroveError) -> bool {
    matches!(
        e,
        GroveError::Sqlite(e)
            if e.sqlite_error_code() == Some(rusqlite::ErrorCode::ConstraintViolation)
    )
}

/// How archive values map onto this Grove.
struct Rekey<'a> {
    target: &'a Target,
    prefixes: &'a [(String, String)],
    /// `readonly_meta` JSON for sessions made read-only by the import.
    readonly_meta: &'a str,
}

/// `readonly_meta` of an imported Session: where it came from (read by the
/// UI's "Imported from <source>" card) and when it was exported.
fn imported_session_meta(manifest: &Manifest) -> String {
    let source = if manifest.source_host.trim().is_empty() {
        manifest.grove_dir.as_str()
    } else {
        manifest.source_host.trim()
    };
    serde_json::json!({ "source": source, "exported_at": manifest.exported_at }).to_string()
}

fn import_rows(
    conn: &Connection,
    tables: &mut BTreeMap<String, Vec<Row>>,
    rekey: &Rekey<'_>,
    report: &mut ImportReport,
) -> Result<()> {
    let target = rekey.target;
    let organizers = organizer_ids(conn, tables, &target.hash)?;
    let now = chrono::Utc::now().to_rfc3339();
    // Review comments that archived replies may attach to.
    let mut reply_parents: HashSet<(String, String)> = HashSet::new();
    let conflicting: HashSet<&str> = report
        .tasks_conflicting
        .iter()
        .map(String::as_str)
        .collect();

    for spec in TABLES {
        let Some(rows) = tables.remove(spec.name) else {
            continue;
        };
        let info = table_info(conn, spec.name)?;
        if info.is_empty() {
            report.tables_skipped.push(spec.name.to_string());
            continue;
        }
        check_required_columns(spec, &info, &rows)?;
        let cols: Vec<String> = info.into_iter().map(|c| c.name).collect();
        let mut count = TableCount::default();
        let task_col = if spec.name == "tasks" {
            "id"
        } else {
            "task_id"
        };
        for mut row in rows {
            if row
                .get(task_col)
                .and_then(Json::as_str)
                .is_some_and(|id| conflicting.contains(id))
            {
                count.skipped += 1;
                continue;
            }
            row.insert(spec.project_col.into(), Json::from(target.hash.as_str()));

            let mut archived = false;
            let mut disabled = false;
            match spec.name {
                "tasks" => archived = prepare_task(&mut row, rekey, &now)?,
                // The Agent's own session stayed on the source machine, so the
                // Session can only be read here. An existing reason is kept.
                "session" if row.get("readonly_reason").is_none_or(Json::is_null) => {
                    row.insert(
                        "readonly_reason".into(),
                        Json::from(tasks::READONLY_IMPORTED),
                    );
                    row.insert("readonly_meta".into(), Json::from(rekey.readonly_meta));
                    row.insert("acp_session_id".into(), Json::Null);
                }
                // A skipped comment can leave its id to an unrelated local
                // comment; replies must not attach to that one.
                "review_replies" if !reply_parents.contains(&review_key(&row, "comment_id")) => {
                    count.skipped += 1;
                    continue;
                }
                "task_linked_projects" | "project_linked_projects" => {
                    let linked = match row.get("linked_project_id").and_then(Json::as_str) {
                        Some(h) => project_exists(conn, h)?,
                        None => false,
                    };
                    if !linked {
                        report.links_dropped += 1;
                        count.skipped += 1;
                        continue;
                    }
                }
                "automations" => {
                    let id = row.get("id").and_then(Json::as_str).unwrap_or_default();
                    let keep = organizers.contains(id);
                    if !keep {
                        disabled = flag(&row, "enabled");
                        row.insert("enabled".into(), Json::from(0));
                    }
                    for c in ["last_run_at", "last_run_status", "last_run_error"] {
                        row.insert(c.into(), Json::Null);
                    }
                    // The scheduler only claims enabled rows with a next run,
                    // so a kept-enabled organizer gets one computed here.
                    let next = if keep && flag(&row, "enabled") {
                        next_run(&row)
                    } else {
                        None
                    };
                    row.insert("next_run_at".into(), next.map_or(Json::Null, Json::from));
                }
                _ => {}
            }

            // No archived id and no natural key → dedupe on full-row equality.
            if !spec.omit_cols.is_empty() && row_exists(conn, spec.name, &row, &cols)? {
                count.skipped += 1;
                continue;
            }
            let inserted = match insert_row(conn, spec.name, &row, &cols) {
                Ok(inserted) => inserted,
                // A row referencing something absent (FK) is skipped, not fatal.
                Err(e) if is_constraint_violation(&e) => false,
                Err(e) => return Err(e),
            };
            if spec.name == "review_comments"
                && (inserted || same_review_comment(conn, &row, &cols)?)
            {
                reply_parents.insert(review_key(&row, "id"));
            }
            if inserted {
                count.inserted += 1;
                report.tasks_archived += usize::from(archived);
                report.automations_disabled += usize::from(disabled);
            } else {
                count.skipped += 1;
            }
        }
        report.rows.insert(spec.name.to_string(), count);
    }
    report.tables_skipped.extend(tables.keys().cloned());
    Ok(())
}

/// `(task_id, <id_col>)` of a review comment or reply, as JSON text.
fn review_key(row: &Row, id_col: &str) -> (String, String) {
    let text = |c: &str| row.get(c).map(Json::to_string).unwrap_or_default();
    (text("task_id"), text(id_col))
}

/// Columns of `review_comments` that Grove updates in place.
const REVIEW_COMMENT_MUTABLE: &[&str] = &["status", "start_line", "end_line", "content"];

/// True if this Grove already holds the archived review comment `row`, as
/// imported before and possibly edited or resolved since.
fn same_review_comment(conn: &Connection, row: &Row, cols: &[String]) -> Result<bool> {
    let mut identity = row.clone();
    for c in REVIEW_COMMENT_MUTABLE {
        identity.remove(*c);
    }
    row_exists(conn, "review_comments", &identity, cols)
}

/// Next fire time of an automation row, as the Memory config handler computes it.
fn next_run(row: &Row) -> Option<i64> {
    let int = |c: &str| row.get(c).and_then(Json::as_i64);
    let cron = row.get("schedule_cron").and_then(Json::as_str)?;
    let window = crate::automation::cron_util::ScheduleWindow {
        run_once_at: int("run_once_at"),
        starts_at: int("starts_at"),
        ends_at: int("ends_at"),
    };
    crate::automation::cron_util::next_scheduled(cron, window)
        .ok()
        .flatten()
}

/// Error if any archive row lacks a column this Grove requires: `INSERT OR
/// IGNORE` would otherwise drop such rows silently. The project column and
/// omitted autoincrement ids are filled in on insert, so they are exempt.
fn check_required_columns(spec: &TableSpec, info: &[Column], rows: &[Row]) -> Result<()> {
    let mut missing: Vec<&str> = info
        .iter()
        .filter(|c| {
            c.required
                && c.name != spec.project_col
                && !spec.omit_cols.contains(&c.name.as_str())
                && rows
                    .iter()
                    .any(|r| r.get(&c.name).is_none_or(Json::is_null))
        })
        .map(|c| c.name.as_str())
        .collect();
    if missing.is_empty() {
        return Ok(());
    }
    missing.sort_unstable();
    Err(GroveError::invalid_data(format!(
        "archive table `{}` lacks required column(s) {}",
        spec.name,
        missing.join(", ")
    )))
}

/// Rewrite the paths of a task row and archive it if its worktree cannot be
/// used here. Returns true if it was archived.
fn prepare_task(row: &mut Row, rekey: &Rekey<'_>, now: &str) -> Result<bool> {
    let is_local = flag(row, "is_local");
    let mut wt = row
        .get("worktree_path")
        .and_then(Json::as_str)
        .map(|wt| rewrite_path(wt, rekey.prefixes))
        .unwrap_or_default();
    if wt.is_empty() && is_local {
        wt = local_worktree(rekey.target);
    }
    // Tasks migrated from the legacy TOML store may have no worktree path.
    let no_worktree = wt.is_empty();
    // Deleting a task removes its worktree directory, so the path must not
    // point anywhere else.
    let wt_path = Path::new(&wt);
    if !no_worktree
        && (!wt_path.is_absolute() || wt_path.components().any(|c| c == Component::ParentDir))
    {
        let id = row.get("id").and_then(Json::as_str).unwrap_or_default();
        return Err(GroveError::invalid_data(format!(
            "archive task `{id}` has an unsafe worktree path `{wt}` (it must be absolute and must not contain `..`)"
        )));
    }
    let keep_active = !no_worktree
        && (rekey.target.project_type != ProjectType::Repo || is_local || wt_path.exists());
    row.insert("worktree_path".into(), Json::from(wt.as_str()));
    // tmux/zellij session names embed the project hash; an empty name is
    // recomputed from the current hash (`session::resolve_session_name`).
    if row.contains_key("session_name") {
        row.insert("session_name".into(), Json::from(""));
    }

    if keep_active || row.get("status").and_then(Json::as_str) != Some("active") {
        return Ok(false);
    }
    row.insert("status".into(), Json::from("archived"));
    row.insert("archived_at".into(), Json::from(now));
    row.insert("updated_at".into(), Json::from(now));
    Ok(true)
}

/// Where the target's Local Task works: the repo itself, or the Studio's
/// `tasks/_local` directory.
fn local_worktree(target: &Target) -> String {
    match target.project_type {
        ProjectType::Studio => workspace::studio_project_dir(&target.path)
            .join("tasks")
            .join(tasks::LOCAL_TASK_ID)
            .to_string_lossy()
            .into_owned(),
        _ => target.path.clone(),
    }
}

/// Byte-level (from, to) replacements applied to chat histories.
type Rewrites = Vec<(Vec<u8>, Vec<u8>)>;

/// Chat histories hold attachment paths and `file://` URIs under the source
/// Grove's project / studio dirs: map each dir to its counterpart here, as a
/// plain, a JSON-escaped and a percent-encoded (URI) path.
fn history_rewrites(manifest: &Manifest, target: &Target) -> Rewrites {
    let old_grove = PathBuf::from(&manifest.grove_dir);
    let new_grove = grove_dir();
    let mut out: Rewrites = Vec::new();
    let mut push = |from: String, to: String| {
        if !from.is_empty() && from != to && !out.iter().any(|(f, _)| f == from.as_bytes()) {
            out.push((from.into_bytes(), to.into_bytes()));
        }
    };
    let json = |s: &str| {
        let quoted = Json::from(s).to_string();
        quoted[1..quoted.len() - 1].to_string()
    };
    for dir in ["projects", "studios"] {
        let old = old_grove.join(dir).join(&manifest.project.hash);
        let new = new_grove.join(dir).join(&target.hash);
        let (old_s, new_s) = (old.to_string_lossy(), new.to_string_lossy());
        push(old_s.to_string(), new_s.to_string());
        push(json(&old_s), json(&new_s));
        if let (Ok(old_u), Ok(new_u)) = (
            url::Url::from_file_path(&old),
            url::Url::from_file_path(&new),
        ) {
            push(old_u.path().to_string(), new_u.path().to_string());
        }
    }
    out
}

/// Replace every occurrence of each `from` in `line`, in order.
fn replace_all(mut line: Vec<u8>, rewrites: &[(Vec<u8>, Vec<u8>)]) -> Vec<u8> {
    for (from, to) in rewrites {
        if line.len() < from.len() || !line.windows(from.len()).any(|w| w == from.as_slice()) {
            continue;
        }
        let mut out = Vec::with_capacity(line.len());
        let mut i = 0;
        while i < line.len() {
            if line[i..].starts_with(from) {
                out.extend_from_slice(to);
                i += from.len();
            } else {
                out.push(line[i]);
                i += 1;
            }
        }
        line = out;
    }
    line
}

/// Stream `src` to `out` line by line, applying `rewrites` to each line.
fn copy_rewritten(
    src: &mut impl std::io::BufRead,
    out: &mut fs::File,
    rewrites: &[(Vec<u8>, Vec<u8>)],
) -> std::io::Result<()> {
    use std::io::Write;
    let mut out = std::io::BufWriter::new(out);
    let mut line = Vec::new();
    loop {
        line.clear();
        if src.read_until(b'\n', &mut line)? == 0 {
            break;
        }
        out.write_all(&replace_all(std::mem::take(&mut line), rewrites))?;
    }
    out.flush()
}

/// Copy regular files under `src` into `dst`, never overwriting, applying
/// `rewrites` to chat histories. On a dry run only counts.
fn copy_tree(
    src: &Path,
    dst: &Path,
    project_root: bool,
    rewrites: &[(Vec<u8>, Vec<u8>)],
    dry_run: bool,
    report: &mut ImportReport,
) -> Result<()> {
    if !src.is_dir() {
        return Ok(());
    }
    for entry in WalkDir::new(src).follow_links(false) {
        let entry = entry.map_err(|e| GroveError::storage(format!("read archive files: {e}")))?;
        if !entry.file_type().is_file() {
            continue;
        }
        let rel = entry
            .path()
            .strip_prefix(src)
            .map_err(|e| GroveError::storage(e.to_string()))?;
        // Older archives may still contain them.
        if project_root && is_project_runtime_file(rel) {
            continue;
        }
        if is_task_file(rel, &report.tasks_conflicting, project_root) {
            report.files_skipped += 1;
            continue;
        }
        let dest = dst.join(rel);
        if !prepare_parent_dirs(dst, rel, dry_run)? {
            report.files_skipped += 1;
            continue;
        }
        if dry_run {
            if fs::symlink_metadata(&dest).is_ok() {
                report.files_skipped += 1;
            } else {
                report.files_copied += 1;
            }
            continue;
        }
        let mut file = fs::File::open(entry.path())?;
        let created = if entry.file_name() == "history.jsonl" && !rewrites.is_empty() {
            write_new(&dest, |out| {
                copy_rewritten(&mut std::io::BufReader::new(file), out, rewrites)
            })?
        } else {
            copy_new(&mut file, &dest)?
        };
        if created {
            report.files_copied += 1;
        } else {
            report.files_skipped += 1;
        }
    }
    Ok(())
}

/// Create the directories between `dst` and the file `rel` one level at a
/// time; false if one of them is a link or not a directory. Studio
/// `resource/` holds links to the user's own directories, which an import
/// must never write into. On a dry run nothing is created.
fn prepare_parent_dirs(dst: &Path, rel: &Path, dry_run: bool) -> Result<bool> {
    if !dry_run {
        fs::create_dir_all(dst)?;
    }
    let Some(parent) = rel.parent() else {
        return Ok(true);
    };
    let mut dir = dst.to_path_buf();
    for component in parent.components() {
        dir.push(component);
        match fs::symlink_metadata(&dir) {
            Ok(meta) => {
                if !meta.is_dir() || crate::fs_link::is_link(&dir) {
                    return Ok(false);
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                if dry_run {
                    return Ok(true);
                }
                if let Err(e) = fs::create_dir(&dir) {
                    if e.kind() != std::io::ErrorKind::AlreadyExists {
                        return Err(e.into());
                    }
                    let meta = fs::symlink_metadata(&dir)?;
                    if !meta.is_dir() || crate::fs_link::is_link(&dir) {
                        return Ok(false);
                    }
                }
            }
            Err(e) => return Err(e.into()),
        }
    }
    Ok(true)
}

/// Write `src` to a new file at `dest`; false if `dest` already exists.
fn copy_new(src: &mut impl std::io::Read, dest: &Path) -> std::io::Result<bool> {
    write_new(dest, |out| std::io::copy(src, out).map(|_| ()))
}

/// Create `dest` and fill it with `write`; false if `dest` already exists.
/// A partial file is removed on failure so a retry does not skip it.
fn write_new(
    dest: &Path,
    write: impl FnOnce(&mut fs::File) -> std::io::Result<()>,
) -> std::io::Result<bool> {
    let mut out = match fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(dest)
    {
        Ok(out) => out,
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => return Ok(false),
        Err(e) => return Err(e),
    };
    if let Err(e) = write(&mut out) {
        drop(out);
        let _ = fs::remove_file(dest); // best effort; report the write error
        return Err(e);
    }
    Ok(true)
}

/// Registration side effects, run once the data is committed (all
/// idempotent). Studio tasks first get back what the archive leaves out.
fn finish_registration(target: &Target) -> Result<()> {
    if target.project_type == ProjectType::Studio {
        let sdir = workspace::studio_project_dir(&target.path);
        fs::create_dir_all(sdir.join("resource"))?;
        let instructions = sdir.join("instructions.md");
        if !instructions.exists() {
            fs::write(&instructions, "")?;
        }
        restore_studio_tasks(&sdir)?;
    }
    workspace::finish_project_registration(
        &target.hash,
        &target.path,
        &target.name,
        &target.project_type,
    )
}

/// Neither links nor empty dirs are archived, so give every Studio task the
/// ones it is missing.
fn restore_studio_tasks(sdir: &Path) -> Result<()> {
    let Ok(entries) = fs::read_dir(sdir.join("tasks")) else {
        return Ok(());
    };
    for entry in entries {
        let task_dir = entry?.path();
        if task_dir.is_dir() {
            crate::operations::tasks::link_studio_task_dir(sdir, &task_dir)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests;

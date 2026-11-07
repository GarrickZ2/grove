//! Export flow: one registered Project → `.tar.gz`.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use super::archive::write_archive;
use super::tables::{dump_rows, TABLES};
use super::{Manifest, ManifestProject, FORMAT_VERSION};
use crate::error::{GroveError, Result};
use crate::storage::workspace::{self, ProjectType, RegisteredProject};
use crate::storage::{database, grove_dir};

#[derive(Debug)]
pub struct ExportSummary {
    pub output: PathBuf,
    pub rows: BTreeMap<String, usize>,
    pub files: usize,
}

fn buddy_error() -> GroveError {
    GroveError::invalid_data("Buddy projects cannot be exported")
}

/// Resolve `selector` (hash, path, or unique name) to a registered Project.
pub fn resolve_project(selector: &str) -> Result<(String, RegisteredProject)> {
    let projects = workspace::load_projects_with_ids()?;

    if let Some(p) = projects.iter().find(|(h, _)| h == selector) {
        return Ok(p.clone());
    }

    // Path candidates: the literal selector (covers `studio://<name>`), its
    // canonical form, and the repo root registration would store for it
    // (handles subdirectories and task worktrees).
    let expanded = workspace::expand_tilde(selector);
    let mut candidates = vec![selector.trim_end_matches(['/', '\\']).to_string()];
    if candidates[0].is_empty() {
        candidates[0] = selector.to_string();
    }
    if let Ok(canon) = std::fs::canonicalize(&expanded) {
        candidates.push(canon.to_string_lossy().to_string());
    }
    if let Ok(root) = workspace::resolve_project_path(selector) {
        candidates.push(root);
    }

    // Buddies are excluded from `projects` above; look them up by hash so the
    // refusal is explicit rather than "not found".
    let mut hashes = vec![selector.to_string()];
    hashes.extend(candidates.iter().map(|c| workspace::project_hash(c)));
    for h in &hashes {
        if let Some(p) = workspace::load_project_by_hash(h)? {
            if p.project_type == ProjectType::Buddy {
                return Err(buddy_error());
            }
        }
    }

    for cand in &candidates {
        if let Some(p) = projects
            .iter()
            .find(|(h, p)| &p.path == cand || *h == workspace::project_hash(cand))
        {
            return Ok(p.clone());
        }
    }

    let by_name: Vec<_> = projects
        .iter()
        .filter(|(_, p)| p.name == selector)
        .collect();
    match by_name.len() {
        0 => Err(GroveError::not_found(format!(
            "no registered project matches `{selector}`"
        ))),
        1 => Ok(by_name[0].clone()),
        _ => {
            let list = by_name
                .iter()
                .map(|(h, p)| format!("  {h}  {}", p.path))
                .collect::<Vec<_>>()
                .join("\n");
            Err(GroveError::invalid_data(format!(
                "project name `{selector}` is ambiguous; pass a hash or path:\n{list}"
            )))
        }
    }
}

/// Export the project with `project_hash` into the archive at `output`.
pub fn export_project(project_hash: &str, output: &Path) -> Result<ExportSummary> {
    let project = workspace::load_project_by_hash(project_hash)?
        .ok_or_else(|| GroveError::not_found(format!("project {project_hash} not found")))?;
    if project.project_type == ProjectType::Buddy {
        return Err(buddy_error());
    }

    // One read transaction → a consistent snapshot across all tables.
    let mut tables = BTreeMap::new();
    {
        let conn = database::try_connection()?;
        let tx = conn.unchecked_transaction()?;
        for spec in TABLES {
            tables.insert(spec.name.to_string(), dump_rows(&tx, spec, project_hash)?);
        }
        tx.finish()?;
    }

    let manifest = Manifest {
        format_version: FORMAT_VERSION,
        grove_version: env!("CARGO_PKG_VERSION").to_string(),
        exported_at: chrono::Utc::now().to_rfc3339(),
        grove_dir: grove_dir().to_string_lossy().to_string(),
        source_host: sysinfo::System::host_name().unwrap_or_default(),
        project: ManifestProject {
            hash: project_hash.to_string(),
            name: project.name.clone(),
            path: project.path.clone(),
            project_type: project.project_type.as_str().to_string(),
            is_git_repo: project.is_git_repo,
        },
    };
    let manifest_json = serde_json::to_vec_pretty(&manifest)
        .map_err(|e| GroveError::storage(format!("encode manifest: {e}")))?;

    let mut roots: Vec<(&str, PathBuf)> = Vec::new();
    let project_dir = grove_dir().join("projects").join(project_hash);
    if project_dir.exists() {
        roots.push(("project", project_dir));
    }
    if project.project_type == ProjectType::Studio {
        roots.push(("studio", workspace::studio_project_dir(&project.path)));
    }

    let files = write_archive(output, &manifest_json, &tables, &roots)?;
    let rows = tables
        .iter()
        .map(|(k, v)| (k.clone(), v.len()))
        .collect::<BTreeMap<_, _>>();
    Ok(ExportSummary {
        output: output.to_path_buf(),
        rows,
        files,
    })
}

/// `<slug>-grove-export-YYYYMMDD.tar.gz`.
pub fn default_export_file_name(project_name: &str, date: chrono::NaiveDate) -> String {
    let slug = project_name
        .to_lowercase()
        .chars()
        .map(|c| if c.is_alphanumeric() { c } else { '-' })
        .collect::<String>();
    let slug = slug.trim_matches('-');
    let slug = if slug.is_empty() { "project" } else { slug };
    format!("{slug}-grove-export-{}.tar.gz", date.format("%Y%m%d"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::database;
    use crate::storage::project_archive::archive::extract_archive;
    use crate::storage::project_archive::test_support::TestGrove;
    use std::fs;

    fn insert_project(name: &str, path: &str, ty: &str) -> String {
        let hash = workspace::project_hash(path);
        database::connection()
            .execute(
                "INSERT INTO projects (hash, name, path, is_git_repo, added_at, project_type)
                 VALUES (?1, ?2, ?3, 1, '2026-01-01T00:00:00+00:00', ?4)",
                rusqlite::params![hash, name, path, ty],
            )
            .unwrap();
        hash
    }

    fn insert_task(project: &str, id: &str) {
        database::connection()
            .execute(
                "INSERT INTO tasks (project, id, name, branch, target, worktree_path, created_at, updated_at)
                 VALUES (?1, ?2, 'n', 'b', 'main', '/wt', 't', 't')",
                rusqlite::params![project, id],
            )
            .unwrap();
    }

    fn read_json(dir: &Path, rel: &str) -> serde_json::Value {
        serde_json::from_slice(&fs::read(dir.join(rel)).unwrap()).unwrap()
    }

    #[test]
    fn export_repo_project_includes_rows_and_files() {
        let _grove = TestGrove::new();
        let a = insert_project("alpha", "/repos/alpha", "repo");
        let b = insert_project("beta", "/repos/beta", "repo");
        insert_task(&a, "t1");
        insert_task(&b, "t2");
        database::connection()
            .execute(
                "INSERT INTO session (session_id, project, task_id, title, agent, created_at)
                 VALUES ('s-other', ?1, 't2', 'T', 'claude', 't')",
                [&b],
            )
            .unwrap();
        {
            let c = database::connection();
            c.execute(
                "INSERT INTO session (session_id, project, task_id, title, agent, created_at)
                 VALUES ('s1', ?1, 't1', 'T', 'claude', 't')",
                [&a],
            )
            .unwrap();
            c.execute(
                "INSERT INTO memory_entities (project_id, entity_id, file_path, title, description, tags_json, content_hash, created_at, updated_at)
                 VALUES (?1, 'e1', 'entities/e1.md', 't', 'd', '[]', 'h', 't', 't')",
                [&a],
            )
            .unwrap();
        }
        let pdir = grove_dir().join("projects").join(&a);
        fs::create_dir_all(pdir.join("memory/entities")).unwrap();
        fs::write(pdir.join("memory/entities/e1.md"), "mem").unwrap();
        fs::create_dir_all(pdir.join("notes")).unwrap();
        fs::write(pdir.join("notes/t1.md"), "note").unwrap();

        let out_dir = tempfile::tempdir().unwrap();
        let out = out_dir.path().join("x.tar.gz");
        let summary = export_project(&a, &out).unwrap();
        assert_eq!(summary.rows["tasks"], 1);
        assert_eq!(summary.rows["session"], 1);
        assert_eq!(summary.rows["memory_entities"], 1);
        assert_eq!(summary.files, 2);

        let ex = tempfile::tempdir().unwrap();
        extract_archive(&out, ex.path()).unwrap();
        let m = read_json(ex.path(), "manifest.json");
        assert_eq!(m["format_version"], 1);
        assert_eq!(m["project"]["hash"], a.as_str());
        assert_eq!(m["project"]["name"], "alpha");
        assert_eq!(m["project"]["path"], "/repos/alpha");
        assert_eq!(m["project"]["project_type"], "repo");
        assert_eq!(m["project"]["is_git_repo"], true);
        assert_eq!(m["grove_dir"], grove_dir().to_string_lossy().as_ref());
        let tasks = read_json(ex.path(), "db/tasks.json");
        assert_eq!(tasks.as_array().unwrap().len(), 1);
        assert_eq!(tasks[0]["id"], "t1");
        let sessions = read_json(ex.path(), "db/session.json");
        assert_eq!(sessions.as_array().unwrap().len(), 1);
        assert_eq!(sessions[0]["session_id"], "s1");
        assert!(ex
            .path()
            .join("files/project/memory/entities/e1.md")
            .exists());
        assert!(ex.path().join("files/project/notes/t1.md").exists());
    }

    #[test]
    fn export_studio_includes_studio_dir() {
        let _grove = TestGrove::new();
        let path = workspace::create_studio_project("Design").unwrap();
        let hash = workspace::project_hash(&path);
        let sdir = workspace::studio_project_dir(&path);
        fs::create_dir_all(&sdir).unwrap();
        fs::write(sdir.join("canvas.excalidraw"), "{}").unwrap();

        let out_dir = tempfile::tempdir().unwrap();
        let out = out_dir.path().join("s.tar.gz");
        export_project(&hash, &out).unwrap();
        let ex = tempfile::tempdir().unwrap();
        extract_archive(&out, ex.path()).unwrap();
        let m = read_json(ex.path(), "manifest.json");
        assert_eq!(m["project"]["project_type"], "studio");
        assert!(ex.path().join("files/studio/canvas.excalidraw").exists());
    }

    #[test]
    fn export_refuses_buddy_project() {
        let _grove = TestGrove::new();
        let h = insert_project("bud", "/buddies/bud", "buddy");
        let out_dir = tempfile::tempdir().unwrap();
        let out = out_dir.path().join("b.tar.gz");
        let err = export_project(&h, &out).unwrap_err().to_string();
        assert!(err.contains("Buddy"), "{err}");
        assert!(!out.exists());
        let err = resolve_project(&h).unwrap_err().to_string();
        assert!(err.contains("Buddy"), "{err}");
        let err = resolve_project("/buddies/bud").unwrap_err().to_string();
        assert!(err.contains("Buddy"), "{err}");
    }

    #[test]
    fn resolve_project_by_hash_path_and_name() {
        let _grove = TestGrove::new();
        let real = tempfile::tempdir().unwrap();
        let canon = fs::canonicalize(real.path()).unwrap();
        let canon_s = canon.to_string_lossy().to_string();
        let h = insert_project("alpha", &canon_s, "repo");
        let studio = insert_project("studio1", "studio://studio1", "studio");

        assert_eq!(resolve_project(&h).unwrap().0, h);
        assert_eq!(resolve_project(&canon_s).unwrap().0, h);
        assert_eq!(resolve_project("alpha").unwrap().0, h);
        assert_eq!(resolve_project("studio://studio1").unwrap().0, studio);
        assert!(resolve_project("nope").is_err());
    }

    #[test]
    fn resolve_project_from_repo_subdirectory() {
        let _grove = TestGrove::new();
        let real = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(real.path()).unwrap();
        let root_s = root.to_string_lossy().to_string();
        crate::git::git_cmd(&root_s, &["init", "-b", "main"]).unwrap();
        let sub = root.join("src/deep");
        fs::create_dir_all(&sub).unwrap();
        let h = insert_project("repo", &root_s, "repo");
        assert_eq!(resolve_project(&sub.to_string_lossy()).unwrap().0, h);
        assert_eq!(resolve_project(&format!("{root_s}/")).unwrap().0, h);
    }

    #[test]
    fn resolve_project_rejects_ambiguous_name() {
        let _grove = TestGrove::new();
        let a = insert_project("same", "/a/same", "repo");
        let b = insert_project("same", "/b/same", "repo");
        let err = resolve_project("same").unwrap_err().to_string();
        assert!(err.contains("ambiguous"));
        assert!(err.contains(&a) && err.contains(&b));
    }

    #[test]
    fn default_export_file_name_slugifies() {
        let d = chrono::NaiveDate::from_ymd_opt(2026, 11, 6).unwrap();
        assert_eq!(
            default_export_file_name("My Repo!", d),
            "my-repo-grove-export-20261106.tar.gz"
        );
    }
}

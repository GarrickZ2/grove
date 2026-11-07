use super::*;
use crate::storage::project_archive::archive::{extract_archive, write_archive};
use crate::storage::project_archive::export::export_project;
use crate::storage::project_archive::tables::Row;
use crate::storage::project_archive::test_support::TestGrove;
use crate::storage::project_archive::FORMAT_VERSION;
use crate::storage::tasks::LOCAL_TASK_ID;
use crate::storage::workspace::{self, ProjectType};
use crate::storage::{database, grove_dir};
use rusqlite::params;
use std::fs;

/// Two Grove installs ("machine A" and "machine B") in one tempdir.
struct Env(TestGrove);

impl Env {
    fn new() -> Env {
        Env(TestGrove::new())
    }
    fn use_a(&self) {
        self.0.use_dir("grove-a");
    }
    fn use_b(&self) {
        self.0.use_dir("grove-b");
    }
    /// A fresh git repo under the tempdir; returns its registration path.
    fn repo(&self, name: &str) -> String {
        let dir = self.0.root.path().join(name);
        fs::create_dir_all(&dir).unwrap();
        let s = fs::canonicalize(&dir)
            .unwrap()
            .to_string_lossy()
            .to_string();
        crate::git::git_cmd(&s, &["init", "-b", "main"]).unwrap();
        workspace::resolve_project_path(&s).unwrap()
    }
    fn archive_path(&self, name: &str) -> PathBuf {
        self.0.root.path().join(name)
    }
}

const LINKED_PRESENT: &str = "feedfeedfeedfeed";
const LINKED_MISSING: &str = "deadbeefdeadbeef";

struct Seed {
    hash: String,
    archive: PathBuf,
}

/// Register a repo project on machine A with one row in every table, plus
/// memory + note files, and export it.
fn seed_repo(env: &Env) -> Seed {
    env.use_a();
    let path = env.repo("repo-a");
    workspace::add_project("alpha", &path).unwrap();
    let hash = workspace::project_hash(&path);
    let wt = grove_dir()
        .join("worktrees")
        .join(&hash)
        .join("t1")
        .to_string_lossy()
        .to_string();
    {
        let c = database::connection();
        let task = "INSERT INTO tasks (project, id, name, branch, target, worktree_path, created_at, updated_at, status, is_local, session_name)
                    VALUES (?1, ?2, 'n', 'b', 'main', ?3, 't', 't', 'active', 0, 'grove-' || ?1 || '-' || ?2)";
        c.execute(task, params![hash, "t1", wt]).unwrap();
        c.execute(task, params![hash, "t2", format!("{path}/sub")])
            .unwrap();
        c.execute(
            "INSERT INTO session (session_id, project, task_id, title, agent, created_at)
             VALUES ('s1', ?1, 't1', 'T', 'claude', 't')",
            [&hash],
        )
        .unwrap();
        for e in ["e1", "e2"] {
            c.execute(
                "INSERT INTO memory_entities (project_id, entity_id, file_path, title, description, tags_json, content_hash, created_at, updated_at)
                 VALUES (?1, ?2, 'entities/' || ?2 || '.md', 't', 'd', '[]', 'h', 't', 't')",
                params![hash, e],
            )
            .unwrap();
        }
        c.execute(
            "INSERT INTO memory_relations (id, project_id, source_entity_id, target_entity_id, relation_type, created_at, updated_at)
             VALUES ('r1', ?1, 'e1', 'e2', 'uses', 't', 't')",
            [&hash],
        )
        .unwrap();
        c.execute(
            "INSERT INTO memory_logs (id, project_id, task_id, title, tags_json, description, created_at)
             VALUES ('l1', ?1, 't1', 'log', '[]', 'd', 't')",
            [&hash],
        )
        .unwrap();
        let auto = "INSERT INTO automations (id, project, name, enabled, task_mode, session_mode, prompt, schedule_cron,
                        last_run_at, last_run_status, last_run_error, next_run_at, created_at, updated_at)
                    VALUES (?1, ?2, 'a', 1, 'new', 'new', 'p', '0 * * * *', 10, 'failed', 'boom', 99, 1, 1)";
        c.execute(auto, params!["a-user", hash]).unwrap();
        c.execute(auto, params!["a-org", hash]).unwrap();
        c.execute(
            "INSERT INTO memory_project_configs (project_id, enabled, organization_automation_id, created_at, updated_at)
             VALUES (?1, 1, 'a-org', 't', 't')",
            [&hash],
        )
        .unwrap();
        c.execute(
            "INSERT INTO review_comments (id, project_key, task_id, content, timestamp)
             VALUES (1, ?1, 't1', 'c', 't')",
            [&hash],
        )
        .unwrap();
        c.execute(
            "INSERT INTO review_replies (id, comment_id, project_key, task_id, content, timestamp)
             VALUES (1, 1, ?1, 't1', 'r', 't')",
            [&hash],
        )
        .unwrap();
        c.execute(
            "INSERT INTO chat_token_usage (project_key, task_id, chat_id, agent, input_tokens, output_tokens, total_tokens, start_ts, end_ts)
             VALUES (?1, 't1', 's1', 'claude', 1, 2, 3, 4, 5)",
            [&hash],
        )
        .unwrap();
        c.execute(
            "INSERT INTO audio_terms (project_hash, type, from_term, target_term) VALUES (?1, 'replace', 'a', 'b')",
            [&hash],
        )
        .unwrap();
        for (i, l) in [LINKED_PRESENT, LINKED_MISSING].iter().enumerate() {
            c.execute(
                "INSERT INTO project_linked_projects (project, linked_project_id, position) VALUES (?1, ?2, ?3)",
                params![hash, l, i as i64],
            )
            .unwrap();
        }
    }
    let pdir = grove_dir().join("projects").join(&hash);
    fs::create_dir_all(pdir.join("memory/entities")).unwrap();
    fs::write(pdir.join("memory/entities/e1.md"), "mem").unwrap();
    fs::create_dir_all(pdir.join("notes")).unwrap();
    fs::write(pdir.join("notes/t1.md"), "note").unwrap();

    let archive = env.archive_path("alpha.tar.gz");
    export_project(&hash, &archive).unwrap();
    Seed { hash, archive }
}

/// Machine B target repo; `sub` exists so task t2's rewritten worktree is live.
fn target_b(env: &Env) -> (String, String) {
    env.use_b();
    let path = env.repo("repo-b");
    fs::create_dir_all(Path::new(&path).join("sub")).unwrap();
    let hash = workspace::project_hash(&path);
    (path, hash)
}

fn opts_for(path: &str) -> ImportOptions {
    ImportOptions {
        path: Some(PathBuf::from(path)),
        ..Default::default()
    }
}

fn count(sql: &str, p: &str) -> i64 {
    database::connection()
        .query_row(sql, [p], |r| r.get(0))
        .unwrap()
}

fn task_row(project: &str, id: &str) -> (String, String, Option<String>) {
    database::connection()
        .query_row(
            "SELECT worktree_path, status, archived_at FROM tasks WHERE project = ?1 AND id = ?2",
            params![project, id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .unwrap()
}

/// Extract `src`, let `edit` change manifest/tables, re-pack to `dst`.
fn repack(
    src: &Path,
    dst: &Path,
    edit: impl FnOnce(&mut serde_json::Value, &mut BTreeMap<String, Vec<Row>>),
) {
    repack_with_files(src, dst, |m, t, _| edit(m, t));
}

/// Like `repack`, but `edit` also gets the extracted directory (`files/...`).
fn repack_with_files(
    src: &Path,
    dst: &Path,
    edit: impl FnOnce(&mut serde_json::Value, &mut BTreeMap<String, Vec<Row>>, &Path),
) {
    let ex = tempfile::tempdir().unwrap();
    extract_archive(src, ex.path()).unwrap();
    let mut manifest: serde_json::Value =
        serde_json::from_slice(&fs::read(ex.path().join("manifest.json")).unwrap()).unwrap();
    let mut tables = BTreeMap::new();
    for e in fs::read_dir(ex.path().join("db")).unwrap() {
        let p = e.unwrap().path();
        let name = p.file_stem().unwrap().to_string_lossy().to_string();
        let rows: Vec<Row> = serde_json::from_slice(&fs::read(&p).unwrap()).unwrap();
        tables.insert(name, rows);
    }
    edit(&mut manifest, &mut tables, ex.path());
    let mut roots = Vec::new();
    for root in ["project", "studio"] {
        let p = ex.path().join("files").join(root);
        if p.exists() {
            roots.push((root, p));
        }
    }
    write_archive(
        dst,
        &serde_json::to_vec(&manifest).unwrap(),
        &tables,
        &roots,
    )
    .unwrap();
}

#[test]
fn rewrite_path_respects_component_boundaries() {
    let p = vec![("/a/repo".to_string(), "/b/new".to_string())];
    assert_eq!(rewrite_path("/a/repo/x", &p), "/b/new/x");
    assert_eq!(rewrite_path("/a/repo", &p), "/b/new");
    assert_eq!(rewrite_path("/a/repo2/x", &p), "/a/repo2/x");
    assert_eq!(rewrite_path("/other", &p), "/other");

    let p = vec![
        ("/g".to_string(), "/G".to_string()),
        ("/g/worktrees/h1".to_string(), "/n/worktrees/h2".to_string()),
    ];
    assert_eq!(rewrite_path("/g/worktrees/h1/t", &p), "/n/worktrees/h2/t");
    assert_eq!(rewrite_path("/g/x", &p), "/G/x");
}

#[test]
fn round_trip_repo_project_to_new_path() {
    let env = Env::new();
    let seed = seed_repo(&env);
    let (path_b, hash_b) = target_b(&env);
    assert_ne!(seed.hash, hash_b);

    let r = import_project(&seed.archive, &opts_for(&path_b)).unwrap();
    assert_eq!(r.project_hash, hash_b);
    assert_eq!(r.project_path, path_b);
    assert_eq!(r.project_name, "alpha");
    assert!(r.registered);
    assert!(!r.dry_run);
    assert_eq!(r.rows["tasks"].inserted, 3);
    assert_eq!(r.rows["session"].inserted, 1);
    assert_eq!(r.rows["memory_entities"].inserted, 2);
    assert_eq!(r.rows["memory_relations"].inserted, 1);
    assert_eq!(r.rows["review_replies"].inserted, 1);
    assert_eq!(r.rows["chat_token_usage"].inserted, 1);
    assert_eq!(r.rows["audio_terms"].inserted, 1);
    assert_eq!(r.rows["review_comments"].inserted, 1);
    assert_eq!(r.rows["memory_project_configs"].inserted, 1);
    assert_eq!(r.rows["automations"].inserted, 2);
    for (table, c) in &r.rows {
        let expected = usize::from(table == "project_linked_projects") * 2;
        assert_eq!(c.skipped, expected, "{table}");
    }
    assert_eq!(r.files_copied, 2);
    assert!(r.tables_skipped.is_empty(), "{:?}", r.tables_skipped);

    let p = workspace::load_project_by_hash(&hash_b).unwrap().unwrap();
    assert_eq!(p.name, "alpha");
    assert_eq!(p.project_type, ProjectType::Repo);
    assert!(p.is_git_repo);
    assert_eq!(
        count("SELECT COUNT(*) FROM session WHERE project = ?1", &hash_b),
        1
    );
    assert_eq!(
        count(
            "SELECT COUNT(*) FROM memory_logs WHERE project_id = ?1",
            &hash_b
        ),
        1
    );
    assert_eq!(
        count("SELECT COUNT(*) FROM tasks WHERE project = ?1", &seed.hash),
        0
    );

    let pdir = grove_dir().join("projects").join(&hash_b);
    assert_eq!(
        fs::read_to_string(pdir.join("memory/entities/e1.md")).unwrap(),
        "mem"
    );
    assert_eq!(
        fs::read_to_string(pdir.join("notes/t1.md")).unwrap(),
        "note"
    );

    assert_eq!(task_row(&hash_b, LOCAL_TASK_ID).0, path_b);
    let session_name: String = database::connection()
        .query_row(
            "SELECT session_name FROM tasks WHERE project = ?1 AND id = 't2'",
            [&hash_b],
            |r| r.get(0),
        )
        .unwrap();
    // Cleared so it is recomputed from the new hash (also for hashed long names).
    assert_eq!(session_name, "");
    assert_eq!(
        crate::session::resolve_session_name(&session_name, &hash_b, "t2"),
        crate::session::session_name(&hash_b, "t2")
    );
    assert_eq!(
        count(
            "SELECT COUNT(*) FROM tasks WHERE project = ?1 AND session_name != ''",
            &hash_b
        ),
        0
    );
    let (wt2, status2, _) = task_row(&hash_b, "t2");
    assert_eq!(wt2, format!("{path_b}/sub"));
    assert_eq!(status2, "active");
}

#[test]
fn missing_worktree_tasks_are_archived() {
    let env = Env::new();
    let seed = seed_repo(&env);
    let (path_b, hash_b) = target_b(&env);
    let r = import_project(&seed.archive, &opts_for(&path_b)).unwrap();
    assert_eq!(r.tasks_archived, 1);

    let (wt, status, archived_at) = task_row(&hash_b, "t1");
    let expected = grove_dir().join("worktrees").join(&hash_b).join("t1");
    assert_eq!(wt, expected.to_string_lossy());
    assert_eq!(status, "archived");
    let at = archived_at.expect("archived_at set");
    chrono::DateTime::parse_from_rfc3339(&at).unwrap();
    // The local task is never archived.
    assert_eq!(task_row(&hash_b, LOCAL_TASK_ID).1, "active");
    // Notes and chats remain.
    assert_eq!(
        count(
            "SELECT COUNT(*) FROM session WHERE project = ?1 AND task_id = 't1'",
            &hash_b
        ),
        1
    );
    assert!(grove_dir()
        .join("projects")
        .join(&hash_b)
        .join("notes/t1.md")
        .exists());
}

#[test]
fn automations_disabled_except_memory_organizer() {
    let env = Env::new();
    let seed = seed_repo(&env);
    let (path_b, _) = target_b(&env);
    let r = import_project(&seed.archive, &opts_for(&path_b)).unwrap();
    assert_eq!(r.automations_disabled, 1);
    let row = |id: &str| -> (
        i64,
        Option<i64>,
        Option<i64>,
        Option<String>,
        Option<String>,
    ) {
        database::connection()
            .query_row(
                "SELECT enabled, next_run_at, last_run_at, last_run_status, last_run_error
                 FROM automations WHERE id = ?1",
                [id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
            )
            .unwrap()
    };
    assert_eq!(row("a-user"), (0, None, None, None, None));
    let (enabled, next, last_at, last_status, last_err) = row("a-org");
    assert_eq!(
        (enabled, last_at, last_status, last_err),
        (1, None, None, None)
    );
    let next = next.expect("organizer keeps a next run so the scheduler claims it");
    assert!(next > chrono::Utc::now().timestamp() - 60);
}

#[test]
fn linked_projects_dropped_when_target_missing() {
    let env = Env::new();
    let seed = seed_repo(&env);
    let (path_b, hash_b) = target_b(&env);
    database::connection()
        .execute(
            "INSERT INTO projects (hash, name, path, is_git_repo, added_at, project_type)
             VALUES (?1, 'linked', '/elsewhere/linked', 1, 't', 'repo')",
            [LINKED_PRESENT],
        )
        .unwrap();
    let r = import_project(&seed.archive, &opts_for(&path_b)).unwrap();
    assert_eq!(r.links_dropped, 1);
    let linked: Vec<String> = database::connection()
        .prepare("SELECT linked_project_id FROM project_linked_projects WHERE project = ?1")
        .unwrap()
        .query_map([&hash_b], |r| r.get(0))
        .unwrap()
        .collect::<std::result::Result<_, _>>()
        .unwrap();
    assert_eq!(linked, vec![LINKED_PRESENT.to_string()]);
}

#[test]
fn reimport_is_idempotent() {
    let env = Env::new();
    let seed = seed_repo(&env);
    let (path_b, hash_b) = target_b(&env);
    import_project(&seed.archive, &opts_for(&path_b)).unwrap();
    let r = import_project(
        &seed.archive,
        &ImportOptions {
            merge: true,
            ..opts_for(&path_b)
        },
    )
    .unwrap();
    assert!(!r.registered);
    assert!(r.tasks_conflicting.is_empty(), "{:?}", r.tasks_conflicting);
    for (table, c) in &r.rows {
        assert_eq!(c.inserted, 0, "{table}");
    }
    assert_eq!(r.files_copied, 0);
    assert_eq!(r.files_skipped, 2);
    assert_eq!(r.tasks_archived, 0);
    assert_eq!(r.automations_disabled, 0);
    assert_eq!(
        count(
            "SELECT COUNT(*) FROM chat_token_usage WHERE project_key = ?1",
            &hash_b
        ),
        1
    );
    assert_eq!(
        count(
            "SELECT COUNT(*) FROM audio_terms WHERE project_hash = ?1",
            &hash_b
        ),
        1
    );
}

#[test]
fn existing_files_are_not_overwritten() {
    let env = Env::new();
    let seed = seed_repo(&env);
    let (path_b, hash_b) = target_b(&env);
    let note = grove_dir()
        .join("projects")
        .join(&hash_b)
        .join("notes/t1.md");
    fs::create_dir_all(note.parent().unwrap()).unwrap();
    fs::write(&note, "local").unwrap();
    let r = import_project(&seed.archive, &opts_for(&path_b)).unwrap();
    assert_eq!(fs::read_to_string(&note).unwrap(), "local");
    assert_eq!(r.files_copied, 1);
    assert_eq!(r.files_skipped, 1);
}

#[test]
fn same_grove_copy_is_refused_without_writes() {
    let env = Env::new();
    let seed = seed_repo(&env);
    env.use_a();
    let path_c = env.repo("repo-c");
    let hash_c = workspace::project_hash(&path_c);
    let projects_before = count("SELECT COUNT(*) FROM projects WHERE ?1 = ?1", "x");

    let err = import_project(&seed.archive, &opts_for(&path_c))
        .unwrap_err()
        .to_string();
    assert!(err.contains("already exists in this Grove"), "{err}");
    assert_eq!(
        count("SELECT COUNT(*) FROM projects WHERE ?1 = ?1", "x"),
        projects_before
    );
    assert_eq!(
        count("SELECT COUNT(*) FROM tasks WHERE project = ?1", &hash_c),
        0
    );
    assert!(!grove_dir().join("projects").join(&hash_c).exists());
}

#[test]
fn round_trip_studio_project() {
    let env = Env::new();
    env.use_a();
    let path = workspace::create_studio_project("Design").unwrap();
    let hash = workspace::project_hash(&path);
    let sdir = workspace::studio_project_dir(&path);
    fs::write(sdir.join("instructions.md"), "be bold").unwrap();
    fs::write(sdir.join("resource/logo.svg"), "<svg/>").unwrap();
    let archive = env.archive_path("design.tar.gz");
    export_project(&hash, &archive).unwrap();

    env.use_b();
    let err = import_project(&archive, &opts_for("/somewhere"))
        .unwrap_err()
        .to_string();
    assert!(err.contains("--name"), "{err}");

    let r = import_project(&archive, &ImportOptions::default()).unwrap();
    assert_eq!(r.project_path, "studio://Design");
    assert_eq!(r.project_hash, hash);
    assert!(r.registered);
    let p = workspace::load_project_by_hash(&hash).unwrap().unwrap();
    assert_eq!(p.project_type, ProjectType::Studio);
    assert!(!p.is_git_repo);

    let sdir_b = workspace::studio_project_dir(&path);
    assert!(sdir_b.starts_with(grove_dir()));
    assert_eq!(
        fs::read_to_string(sdir_b.join("instructions.md")).unwrap(),
        "be bold"
    );
    assert_eq!(
        fs::read_to_string(sdir_b.join("resource/logo.svg")).unwrap(),
        "<svg/>"
    );
    // Studio tasks keep their files and get their shared links back.
    let (wt, status, _) = task_row(&hash, LOCAL_TASK_ID);
    assert_eq!(status, "active");
    assert!(Path::new(&wt).starts_with(&sdir_b), "{wt}");
    assert_eq!(
        fs::read_to_string(Path::new(&wt).join("instructions.md")).unwrap(),
        "be bold"
    );
    // Empty scaffold dirs are not archived; the import recreates them.
    for dir in ["input", "output", "internal", "scripts"] {
        assert!(Path::new(&wt).join(dir).is_dir(), "{dir}");
    }
    let agents = fs::read_to_string(Path::new(&wt).join("AGENTS.md")).unwrap();
    for alias in ["CLAUDE.md", "GEMINI.md"] {
        let p = Path::new(&wt).join(alias);
        assert!(crate::fs_link::is_link(&p), "{alias} is a link");
        assert_eq!(fs::read_to_string(&p).unwrap(), agents, "{alias}");
    }

    // --name imports under a different studio identity.
    let r = import_project(
        &archive,
        &ImportOptions {
            name: Some("Design Copy".into()),
            ..Default::default()
        },
    );
    // No sessions, so no globally unique ids conflict with the first import.
    let r = r.unwrap();
    assert_eq!(r.project_path, "studio://Design Copy");
    assert_eq!(r.project_name, "Design Copy");
}

#[test]
fn dry_run_writes_nothing_but_reports_counts() {
    let env = Env::new();
    let seed = seed_repo(&env);
    let (path_b, hash_b) = target_b(&env);
    let r = import_project(
        &seed.archive,
        &ImportOptions {
            dry_run: true,
            ..opts_for(&path_b)
        },
    )
    .unwrap();
    assert!(r.dry_run);
    assert_eq!(r.rows["tasks"].inserted, 3);
    assert_eq!(r.rows["session"].inserted, 1);
    assert_eq!(r.files_copied, 2);
    assert_eq!(r.tasks_archived, 1);
    assert_eq!(r.automations_disabled, 1);
    assert_eq!(r.links_dropped, 2);

    assert_eq!(count("SELECT COUNT(*) FROM projects WHERE ?1 = ?1", "x"), 0);
    assert_eq!(
        count("SELECT COUNT(*) FROM tasks WHERE project = ?1", &hash_b),
        0
    );
    assert_eq!(
        count("SELECT COUNT(*) FROM session WHERE project = ?1", &hash_b),
        0
    );
    assert!(!grove_dir().join("projects").join(&hash_b).exists());
}

#[test]
fn newer_format_version_refused() {
    let env = Env::new();
    let seed = seed_repo(&env);
    let newer = env.archive_path("newer.tar.gz");
    repack(&seed.archive, &newer, |m, _| {
        m["format_version"] = serde_json::json!(FORMAT_VERSION + 1);
    });
    let (path_b, hash_b) = target_b(&env);
    let err = import_project(&newer, &opts_for(&path_b))
        .unwrap_err()
        .to_string();
    assert!(err.contains("newer Grove"), "{err}");
    assert!(workspace::load_project_by_hash(&hash_b).unwrap().is_none());
}

#[test]
fn unknown_column_ignored_and_unknown_table_reported() {
    let env = Env::new();
    let seed = seed_repo(&env);
    let drift = env.archive_path("drift.tar.gz");
    repack(&seed.archive, &drift, |_, tables| {
        for row in tables.get_mut("tasks").unwrap() {
            row.insert("future_col".into(), "x".into());
        }
        let mut row = Row::new();
        row.insert("project".into(), "p".into());
        tables.insert("future_table".into(), vec![row]);
    });
    let (path_b, hash_b) = target_b(&env);
    let r = import_project(&drift, &opts_for(&path_b)).unwrap();
    assert_eq!(r.rows["tasks"].inserted, 3);
    assert_eq!(r.tables_skipped, vec!["future_table".to_string()]);
    assert_eq!(
        count("SELECT COUNT(*) FROM tasks WHERE project = ?1", &hash_b),
        3
    );
}

#[test]
fn row_violating_foreign_key_is_skipped() {
    let env = Env::new();
    let seed = seed_repo(&env);
    let bad = env.archive_path("bad.tar.gz");
    repack(&seed.archive, &bad, |_, tables| {
        let mut edge = Row::new();
        edge.insert("project".into(), "old".into());
        edge.insert("task_id".into(), "t1".into());
        edge.insert("from_session".into(), "s1".into());
        edge.insert("to_session".into(), "ghost".into());
        edge.insert("created_at".into(), "t".into());
        tables.insert("agent_edge".into(), vec![edge]);
    });
    let (path_b, hash_b) = target_b(&env);
    let r = import_project(&bad, &opts_for(&path_b)).unwrap();
    assert_eq!(r.rows["agent_edge"].inserted, 0);
    assert_eq!(r.rows["agent_edge"].skipped, 1);
    assert_eq!(r.rows["session"].inserted, 1);
    assert_eq!(
        count("SELECT COUNT(*) FROM tasks WHERE project = ?1", &hash_b),
        3
    );
}

#[test]
fn missing_required_column_is_an_error() {
    let env = Env::new();
    let seed = seed_repo(&env);
    let bad = env.archive_path("noname.tar.gz");
    repack(&seed.archive, &bad, |_, tables| {
        for row in tables.get_mut("tasks").unwrap() {
            row.remove("name");
        }
    });
    let (path_b, hash_b) = target_b(&env);
    let err = import_project(&bad, &opts_for(&path_b))
        .unwrap_err()
        .to_string();
    assert!(err.contains("tasks") && err.contains("name"), "{err}");
    assert!(workspace::load_project_by_hash(&hash_b).unwrap().is_none());
    assert_eq!(
        count("SELECT COUNT(*) FROM tasks WHERE project = ?1", &hash_b),
        0
    );
    assert!(!grove_dir().join("projects").join(&hash_b).exists());
}

#[test]
fn failed_copy_leaves_no_partial_file() {
    struct Broken(bool);
    impl std::io::Read for Broken {
        fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
            if std::mem::replace(&mut self.0, true) {
                return Err(std::io::Error::other("disk gone"));
            }
            buf[..4].copy_from_slice(b"part");
            Ok(4)
        }
    }
    let dir = tempfile::tempdir().unwrap();
    let dest = dir.path().join("f.md");
    assert!(copy_new(&mut Broken(false), &dest).is_err());
    assert!(!dest.exists(), "partial file removed");
    // A retry copies it rather than skipping it as existing.
    assert!(copy_new(&mut &b"full"[..], &dest).unwrap());
    assert_eq!(fs::read_to_string(&dest).unwrap(), "full");
    assert!(!copy_new(&mut &b"other"[..], &dest).unwrap());
    assert_eq!(fs::read_to_string(&dest).unwrap(), "full");
}

fn session_readonly(id: &str) -> (Option<String>, Option<String>, Option<String>) {
    database::connection()
        .query_row(
            "SELECT readonly_reason, readonly_meta, acp_session_id FROM session WHERE session_id = ?1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .unwrap()
}

#[test]
fn imported_sessions_become_read_only() {
    let env = Env::new();
    let seed = seed_repo(&env);
    let edited = env.archive_path("ro.tar.gz");
    repack(&seed.archive, &edited, |m, tables| {
        m["source_host"] = serde_json::json!("laptop-a");
        let sessions = tables.get_mut("session").unwrap();
        sessions[0].insert("acp_session_id".into(), "acp-1".into());
        let mut expired = sessions[0].clone();
        expired.insert("session_id".into(), "s-expired".into());
        expired.insert("acp_session_id".into(), serde_json::Value::Null);
        expired.insert("readonly_reason".into(), "agent_expired".into());
        expired.insert("readonly_meta".into(), r#"{"error":"gone"}"#.into());
        sessions.push(expired);
    });
    let (path_b, _) = target_b(&env);
    import_project(&edited, &opts_for(&path_b)).unwrap();

    let (reason, meta, acp) = session_readonly("s1");
    assert_eq!(
        reason.as_deref(),
        Some(crate::storage::tasks::READONLY_IMPORTED)
    );
    assert_eq!(acp, None);
    let meta: serde_json::Value = serde_json::from_str(&meta.unwrap()).unwrap();
    assert_eq!(meta["source"], "laptop-a");
    assert!(meta["exported_at"].is_string(), "{meta}");
    let ro = crate::storage::tasks::chat_readonly("s1").unwrap().unwrap();
    assert_eq!(ro.reason, "imported");

    let (reason, meta, _) = session_readonly("s-expired");
    assert_eq!(reason.as_deref(), Some("agent_expired"));
    assert_eq!(meta.as_deref(), Some(r#"{"error":"gone"}"#));
}

#[test]
fn imported_session_source_falls_back_to_grove_dir() {
    let env = Env::new();
    let seed = seed_repo(&env);
    let old = env.archive_path("old.tar.gz");
    let mut old_grove = String::new();
    repack(&seed.archive, &old, |m, _| {
        m.as_object_mut().unwrap().remove("source_host");
        old_grove = m["grove_dir"].as_str().unwrap().to_string();
    });
    let (path_b, _) = target_b(&env);
    import_project(&old, &opts_for(&path_b)).unwrap();
    let meta: serde_json::Value = serde_json::from_str(&session_readonly("s1").1.unwrap()).unwrap();
    assert_eq!(meta["source"], old_grove.as_str());
}

#[test]
fn registered_target_requires_merge() {
    let env = Env::new();
    let seed = seed_repo(&env);
    let (path_b, hash_b) = target_b(&env);
    workspace::add_project("mine", &path_b).unwrap();
    let tasks_before = count("SELECT COUNT(*) FROM tasks WHERE project = ?1", &hash_b);

    let err = import_project(&seed.archive, &opts_for(&path_b))
        .unwrap_err()
        .to_string();
    assert_eq!(
        err.trim_start_matches("Invalid data: "),
        format!(
            "Project `mine` at {path_b} is already registered in this Grove. \
             Re-run with --merge to add the archived data to it."
        ),
        "{err}"
    );
    assert_eq!(
        count("SELECT COUNT(*) FROM tasks WHERE project = ?1", &hash_b),
        tasks_before
    );
    assert!(!grove_dir()
        .join("projects")
        .join(&hash_b)
        .join("notes")
        .exists());

    // A dry run only previews, so it does not need --merge.
    let r = import_project(
        &seed.archive,
        &ImportOptions {
            dry_run: true,
            ..opts_for(&path_b)
        },
    )
    .unwrap();
    assert!(!r.registered);

    let r = import_project(
        &seed.archive,
        &ImportOptions {
            merge: true,
            ..opts_for(&path_b)
        },
    )
    .unwrap();
    assert!(!r.registered);
    assert_eq!(r.project_name, "mine");
    assert_eq!(r.rows["tasks"].inserted, 2);
}

#[test]
fn runtime_files_in_old_archives_are_not_copied_to_project_dir() {
    let src = tempfile::tempdir().unwrap();
    let runtime = [
        "index.db",
        "index.db-wal",
        "tasks/t1/chats/c1/session.json",
        "tasks/t1/chats/c1/agent.log",
        "tasks/t1/agent.log",
    ];
    let kept = [
        "notes/session.json",
        "memory/index.db",
        "tasks/t1/chats/c1/history.jsonl",
    ];
    for f in runtime.iter().chain(&kept) {
        let p = src.path().join(f);
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, "x").unwrap();
    }
    let dst = tempfile::tempdir().unwrap();
    let mut report = ImportReport::default();
    copy_tree(src.path(), dst.path(), true, &[], false, &mut report).unwrap();
    assert_eq!(report.files_copied, kept.len());
    for f in kept {
        assert!(dst.path().join(f).exists(), "{f}");
    }
    for f in runtime {
        assert!(!dst.path().join(f).exists(), "{f}");
    }

    // The Studio root holds user files: same names are copied.
    let dst = tempfile::tempdir().unwrap();
    let mut report = ImportReport::default();
    copy_tree(src.path(), dst.path(), false, &[], false, &mut report).unwrap();
    assert_eq!(report.files_copied, runtime.len() + kept.len());
}

#[test]
fn unsafe_worktree_path_rejects_the_archive() {
    for bad in ["relative/wt", "/x/../../etc"] {
        let env = Env::new();
        let seed = seed_repo(&env);
        let edited = env.archive_path("wt.tar.gz");
        repack(&seed.archive, &edited, |_, tables| {
            let t = tables
                .get_mut("tasks")
                .unwrap()
                .iter_mut()
                .find(|r| r["id"] == "t2")
                .unwrap();
            t.insert("worktree_path".into(), bad.into());
        });
        let (path_b, hash_b) = target_b(&env);
        let err = import_project(&edited, &opts_for(&path_b)).unwrap_err();
        assert!(matches!(err, GroveError::InvalidData(_)), "{err:?}");
        assert!(err.to_string().contains("`t2`"), "{bad}: {err}");
        assert!(workspace::load_project_by_hash(&hash_b).unwrap().is_none());
        assert_eq!(
            count("SELECT COUNT(*) FROM tasks WHERE project = ?1", &hash_b),
            0
        );
        assert!(!grove_dir().join("projects").join(&hash_b).exists());
    }
}

#[test]
fn history_attachment_uris_are_rewritten() {
    let env = Env::new();
    let seed = seed_repo(&env);
    let old_grove = "/Users/old user/.grove";
    let old = format!("{old_grove}/projects/{}", seed.hash);
    let old_url = format!("file:///Users/old%20user/.grove/projects/{}", seed.hash);
    let line1 = format!(
        r#"{{"type":"user_message","attachments":[{{"uri":"{old_url}/tasks/t1/chats/s1/attachments/a%20b.txt","path":"{old}/tasks/t1/chats/s1/attachments/a b.txt"}}]}}"#
    );
    let line2 = r#"{"type":"message_chunk","text":"/elsewhere/projects/x"}"#;
    let history = "tasks/t1/chats/s1/history.jsonl";
    let edited = env.archive_path("hist.tar.gz");
    repack_with_files(&seed.archive, &edited, |m, _, dir| {
        m["grove_dir"] = serde_json::json!(old_grove);
        let p = dir.join("files/project").join(history);
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(&p, format!("{line1}\n{line2}\n")).unwrap();
        // Not a history file: copied verbatim.
        fs::write(dir.join("files/project/notes/raw.md"), &old).unwrap();
    });
    let (path_b, hash_b) = target_b(&env);
    import_project(&edited, &opts_for(&path_b)).unwrap();

    let new = grove_dir().join("projects").join(&hash_b);
    let new_url = url::Url::from_file_path(&new).unwrap();
    let out = fs::read_to_string(new.join(history)).unwrap();
    let lines: Vec<&str> = out.lines().collect();
    assert_eq!(lines.len(), 2);
    let v: serde_json::Value = serde_json::from_str(lines[0]).unwrap();
    assert_eq!(
        v["attachments"][0]["uri"],
        format!("{new_url}/tasks/t1/chats/s1/attachments/a%20b.txt")
    );
    assert_eq!(
        v["attachments"][0]["path"],
        format!("{}/tasks/t1/chats/s1/attachments/a b.txt", new.display())
    );
    assert_eq!(lines[1], line2);
    assert_eq!(fs::read_to_string(new.join("notes/raw.md")).unwrap(), old);
}

fn merge_opts(path: &str) -> ImportOptions {
    ImportOptions {
        merge: true,
        ..opts_for(path)
    }
}

/// `seed`'s archive with its review comment #1 and reply moved to the Local Task.
fn local_review_archive(env: &Env, seed: &Seed) -> PathBuf {
    let out = env.archive_path("review.tar.gz");
    repack(&seed.archive, &out, |_, tables| {
        for table in ["review_comments", "review_replies"] {
            for row in tables.get_mut(table).unwrap() {
                row.insert("task_id".into(), LOCAL_TASK_ID.into());
            }
        }
    });
    out
}

fn reply_count(hash: &str) -> i64 {
    count(
        "SELECT COUNT(*) FROM review_replies WHERE project_key = ?1",
        hash,
    )
}

#[test]
fn replies_do_not_attach_to_an_unrelated_comment() {
    let env = Env::new();
    let seed = seed_repo(&env);
    let archive = local_review_archive(&env, &seed);
    let (path_b, hash_b) = target_b(&env);
    workspace::add_project("mine", &path_b).unwrap();
    database::connection()
        .execute(
            "INSERT INTO review_comments (id, project_key, task_id, content, timestamp)
             VALUES (1, ?1, ?2, 'my own comment', 'later')",
            params![hash_b, LOCAL_TASK_ID],
        )
        .unwrap();

    let r = import_project(&archive, &merge_opts(&path_b)).unwrap();
    let c = &r.rows["review_comments"];
    assert_eq!((c.inserted, c.skipped), (0, 1));
    let c = &r.rows["review_replies"];
    assert_eq!((c.inserted, c.skipped), (0, 1));
    assert_eq!(reply_count(&hash_b), 0);
}

#[test]
fn replies_attach_to_the_same_comment_on_reimport() {
    let env = Env::new();
    let seed = seed_repo(&env);
    let archive = local_review_archive(&env, &seed);
    let (path_b, hash_b) = target_b(&env);
    import_project(&archive, &opts_for(&path_b)).unwrap();
    assert_eq!(reply_count(&hash_b), 1);

    // Resolving the comment here does not make it a different comment.
    {
        let c = database::connection();
        c.execute(
            "UPDATE review_comments SET status = 'resolved' WHERE project_key = ?1",
            [&hash_b],
        )
        .unwrap();
        c.execute(
            "DELETE FROM review_replies WHERE project_key = ?1",
            [&hash_b],
        )
        .unwrap();
    }
    let r = import_project(&archive, &merge_opts(&path_b)).unwrap();
    assert_eq!(r.rows["review_replies"].inserted, 1);

    let r = import_project(&archive, &merge_opts(&path_b)).unwrap();
    let c = &r.rows["review_replies"];
    assert_eq!((c.inserted, c.skipped), (0, 1));
    assert_eq!(reply_count(&hash_b), 1);
}

#[test]
fn empty_worktree_path_imports_the_task_archived() {
    let env = Env::new();
    let seed = seed_repo(&env);
    let edited = env.archive_path("legacy.tar.gz");
    repack(&seed.archive, &edited, |_, tables| {
        let t = tables
            .get_mut("tasks")
            .unwrap()
            .iter_mut()
            .find(|r| r["id"] == "t2")
            .unwrap();
        t.insert("worktree_path".into(), "".into());
    });
    let (path_b, hash_b) = target_b(&env);
    let r = import_project(&edited, &opts_for(&path_b)).unwrap();
    assert_eq!(r.rows["tasks"].inserted, 3);
    assert_eq!(r.tasks_archived, 2);
    let (wt, status, archived_at) = task_row(&hash_b, "t2");
    assert_eq!((wt.as_str(), status.as_str()), ("", "archived"));
    assert!(archived_at.is_some());
}

#[test]
fn git_archive_needs_a_git_target() {
    let env = Env::new();
    let seed = seed_repo(&env);
    env.use_b();
    let plain = env.archive_path("plain");
    fs::create_dir_all(&plain).unwrap();
    let plain_s = plain.to_string_lossy().to_string();

    let err = import_project(&seed.archive, &opts_for(&plain_s))
        .unwrap_err()
        .to_string();
    assert_eq!(
        err,
        format!(
            "`{plain_s}` is not a git repository. Pass --path <repo> to choose where to import the project."
        )
    );
    assert_eq!(count("SELECT COUNT(*) FROM projects WHERE ?1 = ?1", "x"), 0);
}

#[test]
fn merge_reimport_restores_registration_side_effects() {
    let env = Env::new();
    let seed = seed_repo(&env);
    let (path_b, hash_b) = target_b(&env);
    import_project(&seed.archive, &opts_for(&path_b)).unwrap();
    let slots = || {
        count(
            "SELECT COUNT(*) FROM task_group_slots WHERE project_id = ?1 AND task_id = '_local'",
            &hash_b,
        )
    };
    assert_eq!(slots(), 1);
    // As if the first run had failed after its commit.
    database::connection()
        .execute(
            "DELETE FROM task_group_slots WHERE project_id = ?1",
            [&hash_b],
        )
        .unwrap();

    import_project(&seed.archive, &merge_opts(&path_b)).unwrap();
    assert_eq!(slots(), 1);
}

#[test]
fn studio_name_is_trimmed() {
    let env = Env::new();
    env.use_a();
    let path = workspace::create_studio_project("Design").unwrap();
    let archive = env.archive_path("design.tar.gz");
    export_project(&workspace::project_hash(&path), &archive).unwrap();

    env.use_b();
    workspace::create_studio_project("Design").unwrap();
    let opts = ImportOptions {
        name: Some("Design ".into()),
        ..Default::default()
    };
    let err = import_project(&archive, &opts).unwrap_err().to_string();
    assert!(err.contains("--merge"), "{err}");

    let r = import_project(
        &archive,
        &ImportOptions {
            merge: true,
            ..opts
        },
    )
    .unwrap();
    assert!(!r.registered);
    assert_eq!(r.project_path, "studio://Design");
    assert_eq!(r.project_name, "Design");
}

#[test]
fn hostile_archive_is_refused_before_anything_is_written() {
    use crate::storage::project_archive::test_support::{hostile_tar, raw_file_header};
    use tar::EntryType;

    let env = Env::new();
    let seed = seed_repo(&env);
    let ex = tempfile::tempdir().unwrap();
    extract_archive(&seed.archive, ex.path()).unwrap();
    let manifest = fs::read(ex.path().join("manifest.json")).unwrap();
    let hostile = env.archive_path("hostile.tar.gz");
    hostile_tar(&hostile, |b| {
        let h = raw_file_header(b"manifest.json", EntryType::Regular, manifest.len() as u64);
        b.append(&h, &manifest[..]).unwrap();
        let h = raw_file_header(b"files/project/notes/ok.md", EntryType::Regular, 2);
        b.append(&h, &b"hi"[..]).unwrap();
        let h = raw_file_header(b"files/../../evil.txt", EntryType::Regular, 2);
        b.append(&h, &b"hi"[..]).unwrap();
    });

    let (path_b, hash_b) = target_b(&env);
    let err = import_project(&hostile, &opts_for(&path_b))
        .unwrap_err()
        .to_string();
    assert!(err.contains("unsafe archive entry"), "{err}");
    assert!(workspace::load_project_by_hash(&hash_b).unwrap().is_none());
    assert!(!grove_dir().join("projects").join(&hash_b).exists());
}

#[test]
fn merge_never_writes_through_links_in_the_target() {
    let env = Env::new();
    env.use_a();
    let path = workspace::create_studio_project("Design").unwrap();
    let archive = env.archive_path("design.tar.gz");
    export_project(&workspace::project_hash(&path), &archive).unwrap();
    let edited = env.archive_path("linked.tar.gz");
    repack_with_files(&archive, &edited, |_, _, dir| {
        let p = dir.join("files/studio/resource/ext/sub/x");
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(&p, "payload").unwrap();
        fs::write(dir.join("files/studio/resource/ext/y"), "payload").unwrap();
    });

    env.use_b();
    workspace::create_studio_project("Design").unwrap();
    let outside = tempfile::tempdir().unwrap();
    let sdir = workspace::studio_project_dir(&path);
    crate::fs_link::create_link(outside.path(), &sdir.join("resource/ext")).unwrap();

    // Files of the plain archive already exist here and are skipped too.
    let baseline = import_project(
        &archive,
        &ImportOptions {
            dry_run: true,
            ..merge_opts_studio()
        },
    )
    .unwrap();
    assert_eq!(baseline.files_copied, 0);
    let dry = import_project(
        &edited,
        &ImportOptions {
            dry_run: true,
            ..merge_opts_studio()
        },
    )
    .unwrap();
    let r = import_project(&edited, &merge_opts_studio()).unwrap();
    for report in [&dry, &r] {
        assert_eq!(report.files_copied, 0, "dry_run={}", report.dry_run);
        assert_eq!(
            report.files_skipped,
            baseline.files_skipped + 2,
            "dry_run={}",
            report.dry_run
        );
    }
    assert_eq!(fs::read_dir(outside.path()).unwrap().count(), 0);
}

fn merge_opts_studio() -> ImportOptions {
    ImportOptions {
        merge: true,
        ..Default::default()
    }
}

#[test]
fn local_task_without_worktree_path_gets_the_project_path() {
    let env = Env::new();
    let seed = seed_repo(&env);
    let edited = env.archive_path("legacy-local.tar.gz");
    repack(&seed.archive, &edited, |_, tables| {
        let t = tables
            .get_mut("tasks")
            .unwrap()
            .iter_mut()
            .find(|r| r["id"] == LOCAL_TASK_ID)
            .unwrap();
        t.insert("worktree_path".into(), "".into());
    });
    let (path_b, hash_b) = target_b(&env);
    let r = import_project(&edited, &opts_for(&path_b)).unwrap();
    assert_eq!(r.tasks_archived, 1);
    let (wt, status, archived_at) = task_row(&hash_b, LOCAL_TASK_ID);
    assert_eq!((wt.as_str(), status.as_str()), (path_b.as_str(), "active"));
    assert!(archived_at.is_none());
}

#[test]
fn merge_skips_tasks_whose_id_is_taken_by_a_different_task() {
    let env = Env::new();
    let seed = seed_repo(&env);
    let history = "tasks/t1/chats/s1/history.jsonl";
    let edited = env.archive_path("collide.tar.gz");
    repack_with_files(&seed.archive, &edited, |_, _, dir| {
        let p = dir.join("files/project").join(history);
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(&p, "{}\n").unwrap();
    });
    let (path_b, hash_b) = target_b(&env);
    workspace::add_project("mine", &path_b).unwrap();
    database::connection()
        .execute(
            "INSERT INTO tasks (project, id, name, branch, target, worktree_path, created_at, updated_at)
             VALUES (?1, 't1', 'mine', 'b', 'main', ?2, 'mine', 'mine')",
            params![hash_b, path_b],
        )
        .unwrap();

    let dry = import_project(
        &edited,
        &ImportOptions {
            dry_run: true,
            ..merge_opts(&path_b)
        },
    )
    .unwrap();
    assert_eq!(dry.tasks_conflicting, vec!["t1".to_string()]);
    let r = import_project(&edited, &merge_opts(&path_b)).unwrap();
    assert_eq!(r.tasks_conflicting, vec!["t1".to_string()]);
    assert_eq!(r.files_copied, dry.files_copied);

    assert_eq!(r.rows["tasks"].inserted, 1, "only t2");
    for table in [
        "session",
        "review_comments",
        "review_replies",
        "chat_token_usage",
        "memory_logs",
    ] {
        let c = &r.rows[table];
        assert_eq!((c.inserted, c.skipped), (0, 1), "{table}");
    }
    let (wt, status, _) = task_row(&hash_b, "t1");
    assert_eq!((wt.as_str(), status.as_str()), (path_b.as_str(), "active"));
    let pdir = grove_dir().join("projects").join(&hash_b);
    assert!(!pdir.join("notes/t1.md").exists());
    assert!(!pdir.join(history).exists());
    assert!(pdir.join("memory/entities/e1.md").exists());

    // Unchanged on a second run.
    let again = import_project(&edited, &merge_opts(&path_b)).unwrap();
    assert_eq!(again.tasks_conflicting, vec!["t1".to_string()]);
    assert_eq!(again.files_copied, 0);
    for (table, c) in &again.rows {
        assert_eq!(c.inserted, 0, "{table}");
    }
}

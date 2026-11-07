//! Declarative table specs and a generic SQLite row <-> JSON codec.
//!
//! JSON encoding: NULL -> null, INTEGER -> number (i64), REAL -> number (f64),
//! TEXT -> string, BLOB -> `{"$blob": "<base64 standard>"}`.

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use rusqlite::types::{Value, ValueRef};
use rusqlite::{params_from_iter, Connection};
use serde_json::Value as Json;

use crate::error::{GroveError, Result};

pub(crate) type Row = serde_json::Map<String, Json>;

pub(crate) struct TableSpec {
    pub name: &'static str,
    pub project_col: &'static str,
    /// Autoincrement ids dropped on export.
    pub omit_cols: &'static [&'static str],
    /// Extra SQL AND-clause applied on export.
    pub export_filter: Option<&'static str>,
}

const fn spec(name: &'static str, project_col: &'static str) -> TableSpec {
    TableSpec {
        name,
        project_col,
        omit_cols: &[],
        export_filter: None,
    }
}

/// FK-safe insert order.
pub(crate) const TABLES: &[TableSpec] = &[
    spec("tasks", "project"),
    spec("task_linked_projects", "project"),
    spec("project_linked_projects", "project"),
    spec("session", "project"),
    TableSpec {
        omit_cols: &["edge_id"],
        ..spec("agent_edge", "project")
    },
    spec("review_comments", "project_key"),
    spec("review_replies", "project_key"),
    TableSpec {
        omit_cols: &["id"],
        export_filter: Some("automation_run_id IS NULL"),
        ..spec("chat_token_usage", "project_key")
    },
    spec("memory_entities", "project_id"),
    spec("memory_relations", "project_id"),
    spec("memory_logs", "project_id"),
    spec("automations", "project"),
    spec("memory_project_configs", "project_id"),
    spec("audio_config_project", "project_hash"),
    TableSpec {
        omit_cols: &["id"],
        ..spec("audio_terms", "project_hash")
    },
];

/// Tables deliberately left out of a project archive (`projects` itself is
/// carried by the manifest). Every table must be in `TABLES`, here, or be
/// `projects`; a test enforces it.
#[cfg(test)]
pub(crate) const NOT_EXPORTED: &[&str] = &[
    // Project history that is transient or holds secrets.
    "automation_runs",
    "hook_notifications",
    "agent_pending_message",
    "connects",
    // Buddies: their own projects/sessions, never part of an exported Project.
    "buddies",
    "buddy_segments",
    "buddy_delegations",
    "buddy_groups",
    "buddy_group_members",
    "buddy_group_messages",
    // Task Groups: a global UI layout whose slots point at other projects too.
    "task_groups",
    "task_group_slots",
    // Agents, providers and onboarding: install-wide, per machine.
    "agent_onboarding",
    "ai_provider_capabilities",
    "ai_providers",
    "custom_agent",
    "installed_agents",
    "installed_agents_id_remap",
    // Skills, MCP servers, plugins and their artifacts: installed per machine,
    // keyed by local paths.
    "extension_artifacts",
    "mcp_display_names",
    "mcp_installations",
    "plugins",
    "skill_agents",
    "skill_installed",
    "skill_installed_agents",
    "skill_installed_projects",
    "skill_manifest",
    "skill_sources",
    // Install-wide settings and devices.
    "audio_config",
    "auth_devices",
    "auth_servers",
    "keymap_disabled",
    "keymap_overrides",
    "speaking_profiles",
    "voice_control_config",
];

pub(crate) fn quote(ident: &str) -> String {
    format!("\"{}\"", ident.replace('"', "\"\""))
}

pub(crate) struct Column {
    pub name: String,
    /// NOT NULL without a default, and not filled in by SQLite as the rowid.
    pub required: bool,
}

/// Columns of `table`, in declaration order. Empty if the table is absent.
pub(crate) fn table_info(conn: &Connection, table: &str) -> Result<Vec<Column>> {
    let mut stmt = conn.prepare(&format!("PRAGMA table_info({})", quote(table)))?;
    let info = stmt
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, bool>(3)?,
                r.get::<_, Option<String>>(4)?,
                r.get::<_, i64>(5)?,
            ))
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    let pk_cols = info.iter().filter(|c| c.4 > 0).count();
    Ok(info
        .into_iter()
        .map(|(name, ty, not_null, default, pk)| {
            // A sole INTEGER PRIMARY KEY is an alias of the rowid.
            let rowid = pk > 0 && pk_cols == 1 && ty.eq_ignore_ascii_case("INTEGER");
            Column {
                name,
                required: not_null && default.is_none() && !rowid,
            }
        })
        .collect())
}

/// Column names of `table`, in declaration order. Empty if the table is absent.
pub(crate) fn table_columns(conn: &Connection, table: &str) -> Result<Vec<String>> {
    Ok(table_info(conn, table)?
        .into_iter()
        .map(|c| c.name)
        .collect())
}

fn to_json(v: ValueRef<'_>) -> Json {
    match v {
        ValueRef::Null => Json::Null,
        ValueRef::Integer(i) => Json::from(i),
        // Non-finite floats cannot be stored in JSON; SQLite stores NaN as NULL anyway.
        ValueRef::Real(f) => serde_json::Number::from_f64(f).map_or(Json::Null, Json::Number),
        ValueRef::Text(t) => Json::String(String::from_utf8_lossy(t).into_owned()),
        ValueRef::Blob(b) => {
            let mut m = serde_json::Map::new();
            m.insert("$blob".into(), Json::String(STANDARD.encode(b)));
            Json::Object(m)
        }
    }
}

fn from_json(col: &str, v: &Json) -> Result<Value> {
    Ok(match v {
        Json::Null => Value::Null,
        Json::Number(n) => match n.as_i64() {
            Some(i) => Value::Integer(i),
            None => Value::Real(n.as_f64().ok_or_else(|| {
                GroveError::invalid_data(format!("column {col}: number out of range"))
            })?),
        },
        Json::String(s) => Value::Text(s.clone()),
        Json::Object(m) => match m.get("$blob").and_then(Json::as_str) {
            Some(b64) if m.len() == 1 => Value::Blob(STANDARD.decode(b64).map_err(|e| {
                GroveError::invalid_data(format!("column {col}: bad base64 blob: {e}"))
            })?),
            _ => {
                return Err(GroveError::invalid_data(format!(
                    "column {col}: unsupported object value"
                )))
            }
        },
        Json::Bool(_) | Json::Array(_) => {
            return Err(GroveError::invalid_data(format!(
                "column {col}: unsupported value type"
            )))
        }
    })
}

/// Rows of `spec.name` belonging to `project`, minus omitted columns.
pub(crate) fn dump_rows(conn: &Connection, spec: &TableSpec, project: &str) -> Result<Vec<Row>> {
    let cols: Vec<String> = table_columns(conn, spec.name)?
        .into_iter()
        .filter(|c| !spec.omit_cols.contains(&c.as_str()))
        .collect();
    if cols.is_empty() {
        return Ok(Vec::new());
    }
    let select = cols.iter().map(|c| quote(c)).collect::<Vec<_>>().join(", ");
    let mut sql = format!(
        "SELECT {select} FROM {} WHERE {} = ?1",
        quote(spec.name),
        quote(spec.project_col)
    );
    if let Some(f) = spec.export_filter {
        sql.push_str(&format!(" AND ({f})"));
    }
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt
        .query_map([project], |r| {
            let mut row = Row::new();
            for (i, c) in cols.iter().enumerate() {
                row.insert(c.clone(), to_json(r.get_ref(i)?));
            }
            Ok(row)
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(rows)
}

/// `INSERT OR IGNORE` of `row`, using only columns present in both the row
/// and `target_cols`. Returns true if a row was inserted.
pub(crate) fn insert_row(
    conn: &Connection,
    table: &str,
    row: &Row,
    target_cols: &[String],
) -> Result<bool> {
    let mut cols = Vec::new();
    let mut vals = Vec::new();
    for (k, v) in row {
        if target_cols.contains(k) {
            cols.push(quote(k));
            vals.push(from_json(k, v)?);
        }
    }
    if cols.is_empty() {
        return Ok(false);
    }
    let sql = format!(
        "INSERT OR IGNORE INTO {} ({}) VALUES ({})",
        quote(table),
        cols.join(", "),
        (1..=cols.len())
            .map(|i| format!("?{i}"))
            .collect::<Vec<_>>()
            .join(", ")
    );
    Ok(conn.execute(&sql, params_from_iter(vals))? > 0)
}

/// True if `table` already holds a row equal to `row` on every column present
/// in both (NULL-safe). Used to keep re-imports idempotent for tables whose
/// autoincrement id is omitted from the archive and that have no natural key.
pub(crate) fn row_exists(
    conn: &Connection,
    table: &str,
    row: &Row,
    target_cols: &[String],
) -> Result<bool> {
    let mut preds = Vec::new();
    let mut vals = Vec::new();
    for (k, v) in row {
        if target_cols.contains(k) {
            vals.push(from_json(k, v)?);
            preds.push(format!("{} IS ?{}", quote(k), vals.len()));
        }
    }
    if preds.is_empty() {
        return Ok(false);
    }
    let sql = format!(
        "SELECT EXISTS(SELECT 1 FROM {} WHERE {})",
        quote(table),
        preds.join(" AND ")
    );
    Ok(conn.query_row(&sql, params_from_iter(vals), |r| r.get(0))?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn row_exists_matches_null_safely() {
        let conn = mem("CREATE TABLE u (id INTEGER PRIMARY KEY, a TEXT, b TEXT);
             INSERT INTO u (a, b) VALUES ('x', NULL);");
        let cols = table_columns(&conn, "u").unwrap();
        let mut row = Row::new();
        row.insert("a".into(), "x".into());
        row.insert("b".into(), Json::Null);
        assert!(row_exists(&conn, "u", &row, &cols).unwrap());
        row.insert("b".into(), "y".into());
        assert!(!row_exists(&conn, "u", &row, &cols).unwrap());
    }

    const T: TableSpec = TableSpec {
        name: "t",
        project_col: "p",
        omit_cols: &[],
        export_filter: None,
    };

    fn mem(sql: &str) -> Connection {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch(sql).unwrap();
        c
    }

    const T_SCHEMA: &str =
        "CREATE TABLE t (id INTEGER PRIMARY KEY, p TEXT, i INTEGER, r REAL, s TEXT, b BLOB, n TEXT);";

    #[test]
    fn row_codec_round_trips_all_sqlite_types() {
        let src = mem(T_SCHEMA);
        src.execute(
            "INSERT INTO t VALUES (1, 'proj', 42, 2.5, 'héllo', x'00ff10', NULL)",
            [],
        )
        .unwrap();
        let rows = dump_rows(&src, &T, "proj").unwrap();
        assert_eq!(rows.len(), 1);
        let json = serde_json::to_value(&rows[0]).unwrap();
        assert_eq!(json["b"], serde_json::json!({"$blob": "AP8Q"}));
        assert_eq!(json["i"], serde_json::json!(42));
        assert!(json["n"].is_null());

        let dst = mem(T_SCHEMA);
        let cols = table_columns(&dst, "t").unwrap();
        assert!(insert_row(&dst, "t", &rows[0], &cols).unwrap());
        let (i, r, s, b, n): (i64, f64, String, Vec<u8>, Option<String>) = dst
            .query_row("SELECT i, r, s, b, n FROM t WHERE id = 1", [], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))
            })
            .unwrap();
        assert_eq!(
            (i, r, s.as_str(), b, n),
            (42, 2.5, "héllo", vec![0, 255, 16], None)
        );
    }

    #[test]
    fn dump_rows_filters_by_project_and_omits_columns() {
        let conn = mem(
            "CREATE TABLE chat_token_usage (id INTEGER PRIMARY KEY, project_key TEXT, \
             automation_run_id TEXT, agent TEXT);
             INSERT INTO chat_token_usage VALUES (1, 'a', NULL, 'x');
             INSERT INTO chat_token_usage VALUES (2, 'a', 'run1', 'y');
             INSERT INTO chat_token_usage VALUES (3, 'b', NULL, 'z');",
        );
        let spec = TABLES
            .iter()
            .find(|t| t.name == "chat_token_usage")
            .unwrap();
        let rows = dump_rows(&conn, spec, "a").unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["agent"], "x");
        assert!(!rows[0].contains_key("id"));
    }

    #[test]
    fn dump_rows_and_columns_for_absent_table_are_empty() {
        let conn = mem("");
        assert!(table_columns(&conn, "nope").unwrap().is_empty());
        assert!(dump_rows(&conn, &T, "x").unwrap().is_empty());
    }

    #[test]
    fn insert_row_ignores_unknown_columns_and_duplicates() {
        let conn = mem(T_SCHEMA);
        let cols = table_columns(&conn, "t").unwrap();
        let mut row = Row::new();
        row.insert("id".into(), 7.into());
        row.insert("p".into(), "proj".into());
        row.insert("future_col".into(), "ignored".into());
        assert!(insert_row(&conn, "t", &row, &cols).unwrap());
        assert!(!insert_row(&conn, "t", &row, &cols).unwrap());
    }

    #[test]
    fn table_specs_match_real_schema() {
        let _grove = crate::storage::project_archive::test_support::TestGrove::new();
        let conn = crate::storage::database::try_connection().unwrap();
        for spec in TABLES {
            let cols = table_columns(&conn, spec.name).unwrap();
            assert!(
                cols.contains(&spec.project_col.to_string()),
                "{}",
                spec.name
            );
            for o in spec.omit_cols {
                assert!(cols.contains(&o.to_string()), "{}.{o}", spec.name);
            }
            dump_rows(&conn, spec, "none").unwrap();
        }
    }

    /// A new table must be exported (`TABLES`) or listed in `NOT_EXPORTED`.
    #[test]
    fn every_table_is_declared() {
        let _grove = crate::storage::project_archive::test_support::TestGrove::new();
        let conn = crate::storage::database::try_connection().unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT name FROM sqlite_master
                 WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
            )
            .unwrap();
        let names: Vec<String> = stmt
            .query_map([], |r| r.get(0))
            .unwrap()
            .collect::<std::result::Result<_, _>>()
            .unwrap();
        let undeclared: Vec<&String> = names
            .iter()
            .filter(|n| {
                n.as_str() != "projects"
                    && !TABLES.iter().any(|t| t.name == n.as_str())
                    && !NOT_EXPORTED.contains(&n.as_str())
            })
            .collect();
        assert!(
            undeclared.is_empty(),
            "declare these tables in TABLES or NOT_EXPORTED: {undeclared:?}"
        );
        for n in NOT_EXPORTED {
            assert!(names.iter().any(|t| t == n), "stale NOT_EXPORTED entry {n}");
        }
    }
}

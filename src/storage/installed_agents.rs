//! Marketplace install state (SQLite `installed_agents`).
//!
//! Each row represents an agent the user actively chose to install/manage via
//! grove's marketplace. Auto-detected PATH availability is NOT recorded here
//! — it comes from runtime probe in the marketplace handler. Keeping the two
//! sources separate means a user's pre-existing `claude` install on PATH
//! never collides with grove's own install bookkeeping.

use chrono::{DateTime, Utc};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

use crate::error::Result;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum InstallMethod {
    Npx,
    Binary,
    Uvx,
    /// Agent isn't managed by grove — the binary lives on the user's PATH
    /// (auto-detected). The row exists only because the user customized
    /// `launch_mode` / `args_override` / `env_override` / `hidden` for it.
    External,
}

impl InstallMethod {
    pub fn as_str(&self) -> &'static str {
        match self {
            InstallMethod::Npx => "npx",
            InstallMethod::Binary => "binary",
            InstallMethod::Uvx => "uvx",
            InstallMethod::External => "external",
        }
    }
    fn from_str(s: &str) -> Option<Self> {
        match s {
            "npx" => Some(InstallMethod::Npx),
            "binary" => Some(InstallMethod::Binary),
            "uvx" => Some(InstallMethod::Uvx),
            "external" => Some(InstallMethod::External),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum InstallStatus {
    Installing,
    Installed,
    Failed,
}

impl InstallStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            InstallStatus::Installing => "installing",
            InstallStatus::Installed => "installed",
            InstallStatus::Failed => "failed",
        }
    }
    fn from_str(s: &str) -> Self {
        match s {
            "installing" => InstallStatus::Installing,
            "failed" => InstallStatus::Failed,
            _ => InstallStatus::Installed,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InstalledAgent {
    pub id: String, // canonical id (e.g. claude-acp)
    pub version: String,
    pub install_method: InstallMethod,
    pub install_path: Option<String>,
    pub status: InstallStatus,
    pub failure_reason: Option<String>,
    #[serde(default)]
    pub args_override: Vec<String>,
    #[serde(default)]
    pub env_override: HashMap<String, String>,
    pub launch_mode: String, // "acp" | "terminal"
    pub hidden: bool,
    pub installed_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

fn parse_args(s: Option<String>) -> Vec<String> {
    s.and_then(|json| serde_json::from_str(&json).ok())
        .unwrap_or_default()
}

fn parse_env(s: Option<String>) -> HashMap<String, String> {
    s.and_then(|json| serde_json::from_str(&json).ok())
        .unwrap_or_default()
}

fn parse_dt(s: &str) -> DateTime<Utc> {
    DateTime::parse_from_rfc3339(s)
        .map(|dt| dt.with_timezone(&Utc))
        .unwrap_or_else(|_| Utc::now())
}

fn row_to_installed(row: &rusqlite::Row<'_>) -> rusqlite::Result<InstalledAgent> {
    let install_method: String = row.get(2)?;
    let status: String = row.get(4)?;
    let args_json: Option<String> = row.get(6)?;
    let env_json: Option<String> = row.get(7)?;
    let hidden: i64 = row.get(9)?;
    let installed_at: String = row.get(10)?;
    let updated_at: String = row.get(11)?;
    Ok(InstalledAgent {
        id: row.get(0)?,
        version: row.get(1)?,
        install_method: InstallMethod::from_str(&install_method).unwrap_or(InstallMethod::Npx),
        install_path: row.get(3)?,
        status: InstallStatus::from_str(&status),
        failure_reason: row.get(5)?,
        args_override: parse_args(args_json),
        env_override: parse_env(env_json),
        launch_mode: row.get(8)?,
        hidden: hidden != 0,
        installed_at: parse_dt(&installed_at),
        updated_at: parse_dt(&updated_at),
    })
}

const COLUMNS: &str = "id, version, install_method, install_path, status, failure_reason, args_override, env_override, launch_mode, hidden, installed_at, updated_at";

pub fn list() -> Result<Vec<InstalledAgent>> {
    let conn = crate::storage::database::connection();
    let mut stmt = conn.prepare(&format!(
        "SELECT {} FROM installed_agents ORDER BY installed_at ASC",
        COLUMNS
    ))?;
    let rows = stmt
        .query_map([], row_to_installed)?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(rows)
}

pub fn get(id: &str) -> Result<Option<InstalledAgent>> {
    let conn = crate::storage::database::connection();
    let row = conn
        .query_row(
            &format!("SELECT {} FROM installed_agents WHERE id = ?1", COLUMNS),
            params![id],
            row_to_installed,
        )
        .optional()?;
    Ok(row)
}

/// Insert or replace — used both for fresh installs and re-install / upgrade.
/// Callers that want CAS-style "only if not exists" should `get()` first.
pub fn upsert(agent: &InstalledAgent) -> Result<()> {
    let conn = crate::storage::database::connection();
    let args_json = serde_json::to_string(&agent.args_override).unwrap_or_else(|_| "[]".into());
    let env_json = serde_json::to_string(&agent.env_override).unwrap_or_else(|_| "{}".into());
    conn.execute(
        &format!(
            "INSERT INTO installed_agents ({columns})
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
             ON CONFLICT(id) DO UPDATE SET
                 version        = excluded.version,
                 install_method = excluded.install_method,
                 install_path   = excluded.install_path,
                 status         = excluded.status,
                 failure_reason = excluded.failure_reason,
                 args_override  = excluded.args_override,
                 env_override   = excluded.env_override,
                 launch_mode    = excluded.launch_mode,
                 hidden         = excluded.hidden,
                 updated_at     = excluded.updated_at",
            columns = COLUMNS
        ),
        params![
            agent.id,
            agent.version,
            agent.install_method.as_str(),
            agent.install_path,
            agent.status.as_str(),
            agent.failure_reason,
            args_json,
            env_json,
            agent.launch_mode,
            agent.hidden as i64,
            agent.installed_at.to_rfc3339(),
            agent.updated_at.to_rfc3339(),
        ],
    )?;
    Ok(())
}

pub fn delete(id: &str) -> Result<bool> {
    let conn = crate::storage::database::connection();
    let n = conn.execute("DELETE FROM installed_agents WHERE id = ?1", params![id])?;
    Ok(n > 0)
}

/// Patch a subset of fields, creating a minimal External row if the agent
/// isn't tracked yet. This is the single entry point for the marketplace
/// per-agent settings sheet — works uniformly for grove-installed and
/// auto-detected agents (the latter gets an `install_method=External` stub
/// the first time the user touches a setting).
///
/// `None` arguments leave the corresponding field unchanged on existing rows
/// (and use defaults on freshly-created stubs).
#[allow(clippy::too_many_arguments)]
pub fn patch_or_create(
    id: &str,
    args_override: Option<Vec<String>>,
    env_override: Option<HashMap<String, String>>,
    launch_mode: Option<String>,
    hidden: Option<bool>,
) -> Result<InstalledAgent> {
    let now = Utc::now();
    let mut current = get(id)?.unwrap_or_else(|| InstalledAgent {
        id: id.to_string(),
        version: String::new(),
        install_method: InstallMethod::External,
        install_path: None,
        status: InstallStatus::Installed,
        failure_reason: None,
        args_override: Vec::new(),
        env_override: HashMap::new(),
        launch_mode: "acp".to_string(),
        hidden: false,
        installed_at: now,
        updated_at: now,
    });
    if let Some(a) = args_override {
        current.args_override = a;
    }
    if let Some(e) = env_override {
        current.env_override = e;
    }
    if let Some(m) = launch_mode {
        current.launch_mode = m;
    }
    if let Some(h) = hidden {
        current.hidden = h;
    }
    current.updated_at = now;
    upsert(&current)?;
    Ok(current)
}

/// Resolve the spawn command + args for a launched agent, honoring grove-
/// managed install state. Returns `None` to mean "fall back to the default
/// resolution" — caller continues with whatever `acp::resolve_agent` gave it.
///
/// Cases:
///   - `Npx`/`Uvx`: rebuild `npx -y <pkg>@<version>` so the version actually
///     pinned at install time is the one we spawn. Falls back when the row
///     has no version (shouldn't happen post-install but defensive).
///   - `Binary`: use the install_path on disk; if it's been deleted out
///     from under us, return None so the caller falls back to PATH lookup
///     (better degraded behavior than a "program not found" panic).
///   - `External`: row only stores prefs, not a launchable artifact —
///     fall through to default resolution.
pub fn spawn_for(
    rec: &InstalledAgent,
    supplement: Option<&crate::storage::agent_supplement::SupplementEntry>,
) -> Option<(String, Vec<String>)> {
    match rec.install_method {
        InstallMethod::Npx => {
            let pkg = supplement?.npx_package?;
            let pinned = if rec.version.is_empty() {
                pkg.to_string()
            } else {
                format!("{}@{}", pkg, rec.version)
            };
            Some(("npx".to_string(), vec!["-y".to_string(), pinned]))
        }
        InstallMethod::Uvx => {
            let pkg = supplement?.npx_package?;
            let pinned = if rec.version.is_empty() {
                pkg.to_string()
            } else {
                format!("{}@{}", pkg, rec.version)
            };
            Some(("uvx".to_string(), vec![pinned]))
        }
        InstallMethod::Binary => {
            let path = rec.install_path.as_ref()?;
            if !std::path::Path::new(path).exists() {
                eprintln!(
                    "[installed_agents] install_path missing for {} — falling back to PATH: {}",
                    rec.id, path
                );
                return None;
            }
            Some((path.clone(), Vec::new()))
        }
        InstallMethod::External => None,
    }
}

/// Boot-time recovery: any row stuck in `installing` is an aborted install
/// (Grove crashed or got SIGKILL mid-download / mid-extract). Mark such
/// rows as failed with a clear reason so the user sees them as Retry-able
/// in Marketplace instead of a perpetual spinner. Called once on server
/// start; safe to run on an empty table (no-op).
pub fn recover_orphaned_installing() -> Result<()> {
    let conn = crate::storage::database::connection();
    let now = Utc::now().to_rfc3339();
    conn.execute(
        "UPDATE installed_agents
         SET status = 'failed',
             failure_reason = 'install interrupted (grove exited before download finished); retry from Marketplace',
             updated_at = ?1
         WHERE status = 'installing'",
        params![now],
    )?;
    Ok(())
}

// Wired in P3 (binary install status transitions during download/extract).
#[allow(dead_code)]
pub fn set_status(id: &str, status: InstallStatus, failure_reason: Option<String>) -> Result<()> {
    let conn = crate::storage::database::connection();
    conn.execute(
        "UPDATE installed_agents
         SET status = ?1, failure_reason = ?2, updated_at = ?3
         WHERE id = ?4",
        params![status.as_str(), failure_reason, Utc::now().to_rfc3339(), id],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fresh(id: &str) -> InstalledAgent {
        let now = Utc::now();
        InstalledAgent {
            id: id.to_string(),
            version: "1.0.0".into(),
            install_method: InstallMethod::Npx,
            install_path: None,
            status: InstallStatus::Installed,
            failure_reason: None,
            args_override: vec![],
            env_override: HashMap::new(),
            launch_mode: "acp".into(),
            hidden: false,
            installed_at: now,
            updated_at: now,
        }
    }

    #[tokio::test]
    async fn upsert_get_delete_roundtrip() {
        let _l = crate::storage::database::test_lock().lock().await;
        let temp = tempfile::tempdir().unwrap();
        crate::storage::set_grove_dir_override(Some(temp.path().to_path_buf()));

        upsert(&fresh("claude-acp")).unwrap();
        let got = get("claude-acp").unwrap().unwrap();
        assert_eq!(got.version, "1.0.0");
        assert_eq!(got.install_method, InstallMethod::Npx);

        let removed = delete("claude-acp").unwrap();
        assert!(removed);
        assert!(get("claude-acp").unwrap().is_none());

        crate::storage::set_grove_dir_override(None);
    }

    #[tokio::test]
    async fn patch_only_specified_fields() {
        let _l = crate::storage::database::test_lock().lock().await;
        let temp = tempfile::tempdir().unwrap();
        crate::storage::set_grove_dir_override(Some(temp.path().to_path_buf()));

        let mut agent = fresh("codex-acp");
        agent.args_override = vec!["--foo".into()];
        upsert(&agent).unwrap();

        let updated =
            patch_or_create("codex-acp", None, None, Some("terminal".to_string()), None).unwrap();
        assert_eq!(updated.launch_mode, "terminal");
        assert_eq!(updated.args_override, vec!["--foo".to_string()]); // untouched

        crate::storage::set_grove_dir_override(None);
    }
}

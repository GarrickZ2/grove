//! Revocable browser authorizations. Credentials are never stored in plaintext.

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use rusqlite::{params, OptionalExtension};
use serde::Serialize;
use std::{collections::HashMap, net::SocketAddr};

use super::database;
use crate::error::Result;

struct AuthorizationChanges {
    path: std::path::PathBuf,
    changes: tokio::sync::watch::Sender<u64>,
    _watcher: RecommendedWatcher,
}

/// Wake live connections on authorization changes, including writes by another
/// Grove process. No authentication timer or background HTTP check is needed.
pub(crate) fn subscribe_to_changes(
) -> std::result::Result<tokio::sync::watch::Receiver<u64>, String> {
    static WATCHER: std::sync::Mutex<Option<AuthorizationChanges>> = std::sync::Mutex::new(None);
    // FSEvents reports canonical paths; watching a /var or other symlink
    // otherwise loses events when notify compares them to its watched paths.
    let path = super::grove_dir()
        .canonicalize()
        .map_err(|error| error.to_string())?;
    let mut watcher = WATCHER.lock().map_err(|error| error.to_string())?;
    if watcher.as_ref().is_none_or(|state| state.path != path) {
        let changes = tokio::sync::watch::channel(0_u64).0;
        let sender = changes.clone();
        let mut events =
            notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
                let database_changed = match event {
                    Ok(event) => {
                        !matches!(event.kind, notify::EventKind::Access(_))
                            && event.paths.iter().any(|path| {
                                path.file_name().is_some_and(|name| name == "auth-revoked")
                            })
                    }
                    Err(_) => true,
                };
                if database_changed {
                    sender.send_modify(|version| *version = version.wrapping_add(1));
                }
            })
            .map_err(|error| error.to_string())?;
        events
            .watch(&path, RecursiveMode::NonRecursive)
            .map_err(|error| error.to_string())?;
        *watcher = Some(AuthorizationChanges {
            path,
            changes,
            _watcher: events,
        });
    }
    Ok(watcher
        .as_ref()
        .expect("watcher initialized")
        .changes
        .subscribe())
}

/// SQLite keeps its WAL open, which can defer filesystem modification events.
/// Close a small notification file after the transaction instead. It contains
/// no credential or device metadata and is shared by local Grove processes.
fn publish_revocation() -> Result<()> {
    std::fs::write(
        super::grove_dir().join("auth-revoked"),
        chrono::Utc::now().to_rfc3339(),
    )?;
    Ok(())
}

#[derive(Clone, Serialize)]
pub struct Device {
    pub id: String,
    pub name: String,
    pub client: String,
    pub trusted: bool,
    pub created_at: i64,
    pub last_used_at: i64,
    #[serde(skip)]
    pub token_hash: Option<String>,
    #[serde(skip)]
    pub browser_id: Option<String>,
}

impl Device {
    pub(crate) fn browser_id(&self) -> &str {
        self.browser_id.as_deref().unwrap_or(&self.id)
    }
}

fn read_device(row: &rusqlite::Row<'_>) -> rusqlite::Result<Device> {
    Ok(Device {
        id: row.get(0)?,
        name: row.get(1)?,
        client: row.get(2)?,
        trusted: row.get(3)?,
        created_at: row.get(4)?,
        last_used_at: row.get(5)?,
        token_hash: row.get(6)?,
        browser_id: row.get(7)?,
    })
}

pub fn insert(scope: &str, device: &Device, replaced_ids: &[String]) -> Result<()> {
    let db = database::connection();
    let transaction = db.unchecked_transaction()?;
    transaction.execute(
        "INSERT INTO auth_devices
         (scope, id, name, client, trusted, created_at, last_used_at, expires_at, token_hash, browser_id)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0, ?8, ?9)",
        params![
            scope,
            device.id,
            device.name,
            device.client,
            device.trusted,
            device.created_at,
            device.last_used_at,
            device.token_hash,
            device.browser_id
        ],
    )?;
    for id in replaced_ids {
        if id != &device.id {
            transaction.execute(
                "DELETE FROM auth_devices WHERE scope = ?1 AND id = ?2",
                params![scope, id],
            )?;
        }
    }
    transaction.commit()?;
    if !replaced_ids.is_empty() {
        publish_revocation()?;
    }
    Ok(())
}

pub fn get(scope: &str, id: &str) -> Result<Option<Device>> {
    Ok(database::connection()
        .query_row(
            "SELECT id, name, client, trusted, created_at, last_used_at, token_hash, browser_id
         FROM auth_devices WHERE scope = ?1 AND id = ?2",
            params![scope, id],
            read_device,
        )
        .optional()?)
}

pub fn list(scope: &str) -> Result<Vec<Device>> {
    let db = database::connection();
    let mut statement = db.prepare(
        "SELECT id, name, client, trusted, created_at, last_used_at, token_hash, browser_id
         FROM auth_devices WHERE scope = ?1 ORDER BY last_used_at DESC",
    )?;
    let devices = statement.query_map([scope], read_device)?;
    Ok(devices.collect::<rusqlite::Result<Vec<_>>>()?)
}

/// Local Web/GUI can administer authorizations from all Mobile passwords.
/// The scope remains internal and must never be returned to the browser.
pub(crate) fn list_all() -> Result<Vec<(String, Device)>> {
    let db = database::connection();
    let mut statement = db.prepare(
        "SELECT id, name, client, trusted, created_at, last_used_at, token_hash, browser_id, scope
         FROM auth_devices ORDER BY last_used_at DESC",
    )?;
    let devices = statement.query_map([], |row| Ok((row.get(8)?, read_device(row)?)))?;
    Ok(devices.collect::<rusqlite::Result<Vec<_>>>()?)
}

pub(crate) fn server_ports() -> Result<HashMap<String, u16>> {
    let db = database::connection();
    let mut statement = db.prepare("SELECT scope, id FROM auth_servers")?;
    let servers = statement.query_map([], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })?;
    let mut ports = HashMap::new();
    for server in servers {
        let (scope, address) = server?;
        if let Ok(address) = address.parse::<SocketAddr>() {
            ports.insert(scope, address.port());
        }
    }
    Ok(ports)
}

pub fn rename(scope: &str, id: &str, name: &str) -> Result<bool> {
    Ok(database::connection().execute(
        "UPDATE auth_devices SET name = ?3 WHERE scope = ?1 AND COALESCE(browser_id, id) = ?2",
        params![scope, id, name],
    )? > 0)
}

pub fn touch(scope: &str, id: &str) -> Result<()> {
    let now = chrono::Utc::now().timestamp();
    database::connection().execute(
        "UPDATE auth_devices SET last_used_at = ?3
         WHERE scope = ?1 AND id = ?2 AND last_used_at < ?3 - 60",
        params![scope, id, now],
    )?;
    Ok(())
}

pub(crate) fn bind_browser(scope: &str, id: &str, browser_id: &str) -> Result<()> {
    database::connection().execute(
        "UPDATE auth_devices SET browser_id = ?3 WHERE scope = ?1 AND id = ?2 AND browser_id IS NULL",
        params![scope, id, browser_id],
    )?;
    Ok(())
}

pub(crate) fn trust_signed_session(scope: &str, id: &str) -> Result<bool> {
    Ok(database::connection().execute(
        "UPDATE auth_devices SET trusted = 1, expires_at = 0
         WHERE scope = ?1 AND id = ?2 AND token_hash IS NULL",
        params![scope, id],
    )? > 0)
}

/// Preserve a server's generation on restart, and permanently revoke it when
/// its password changes. The random generation cannot be recovered by reusing
/// an earlier password. Each listening address and port has its own identity.
pub(crate) fn activate_server(
    server: &str,
    password_scope: &str,
    new_scope: &str,
) -> Result<String> {
    let db = database::connection();
    let transaction = db.unchecked_transaction()?;
    // The development implementation used one global Mobile identity. It
    // cannot be assigned to a particular port, so revoke it once on upgrade.
    transaction.execute(
        "DELETE FROM auth_devices WHERE scope = (SELECT scope FROM auth_servers WHERE id = 'mobile')",
        [],
    )?;
    transaction.execute("DELETE FROM auth_servers WHERE id = 'mobile'", [])?;
    let previous: Option<(String, String)> = transaction
        .query_row(
            "SELECT password_scope, scope FROM auth_servers WHERE id = ?1",
            [server],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    if let Some((password, scope)) = &previous {
        if password == password_scope {
            transaction.commit()?;
            return Ok(scope.clone());
        }
        transaction.execute("DELETE FROM auth_devices WHERE scope = ?1", [scope])?;
    } else {
        // The old password-scoped format has no password-change history.
        // Revoke it once instead of possibly adopting a resurrected credential.
        transaction.execute(
            "DELETE FROM auth_devices WHERE scope NOT IN (SELECT scope FROM auth_servers)",
            [],
        )?;
    }
    transaction.execute(
        "INSERT INTO auth_servers (id, password_scope, scope) VALUES (?1, ?2, ?3)
         ON CONFLICT(id) DO UPDATE SET password_scope = excluded.password_scope, scope = excluded.scope",
        params![server, password_scope, new_scope],
    )?;
    transaction.commit()?;
    publish_revocation()?;
    Ok(new_scope.to_owned())
}

#[cfg(test)]
pub fn revoke(scope: &str, id: &str) -> Result<()> {
    database::connection().execute(
        "DELETE FROM auth_devices WHERE scope = ?1 AND id = ?2",
        params![scope, id],
    )?;
    publish_revocation()?;
    Ok(())
}

pub(crate) fn revoke_browser(scope: &str, browser_id: &str) -> Result<()> {
    database::connection().execute(
        "DELETE FROM auth_devices WHERE scope = ?1 AND COALESCE(browser_id, id) = ?2",
        params![scope, browser_id],
    )?;
    publish_revocation()?;
    Ok(())
}

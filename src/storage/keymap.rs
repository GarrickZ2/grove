//! User keymap overrides (DAO).
//!
//! Tables `keymap_overrides` + `keymap_disabled` hold per-command user
//! customisation of the static catalog. The frontend's
//! `userKeymapStore` mirrors this state in memory; the GET endpoint
//! returns both arrays in one round-trip on app startup.

use rusqlite::params;
use serde::{Deserialize, Serialize};

use crate::error::Result;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KeymapOverride {
    pub command_id: String,
    pub key: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub when_ctx: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scope: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct KeymapBundle {
    pub overrides: Vec<KeymapOverride>,
    pub disabled: Vec<String>,
}

fn empty_to_none(s: String) -> Option<String> {
    if s.is_empty() {
        None
    } else {
        Some(s)
    }
}

fn none_to_empty(s: Option<&str>) -> &str {
    s.unwrap_or("")
}

/// Fetch all overrides + disabled command ids in one round-trip.
pub fn load_bundle() -> Result<KeymapBundle> {
    let conn = crate::storage::database::connection();

    let mut overrides_stmt =
        conn.prepare("SELECT command_id, key, when_ctx, scope FROM keymap_overrides")?;
    let overrides: Vec<KeymapOverride> = overrides_stmt
        .query_map([], |row| {
            let command_id: String = row.get(0)?;
            let key: String = row.get(1)?;
            let when_ctx: String = row.get(2)?;
            let scope: String = row.get(3)?;
            Ok(KeymapOverride {
                command_id,
                key,
                when_ctx: empty_to_none(when_ctx),
                scope: empty_to_none(scope),
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    let mut disabled_stmt = conn.prepare("SELECT command_id FROM keymap_disabled")?;
    let disabled: Vec<String> = disabled_stmt
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    Ok(KeymapBundle {
        overrides,
        disabled,
    })
}

/// Replace the full set of bindings for a command: delete every existing row
/// for `command_id`, then insert each provided binding — all in one
/// transaction so the binding set never lands half-updated. An empty slice
/// clears the command's overrides (an explicit unbind).
pub fn set_overrides(command_id: &str, bindings: &[KeymapOverride]) -> Result<()> {
    let conn = crate::storage::database::connection();
    let tx = conn.unchecked_transaction()?;
    tx.execute(
        "DELETE FROM keymap_overrides WHERE command_id = ?1",
        params![command_id],
    )?;
    {
        let mut stmt = tx.prepare(
            "INSERT INTO keymap_overrides (command_id, key, when_ctx, scope)
             VALUES (?1, ?2, ?3, ?4)",
        )?;
        for b in bindings {
            stmt.execute(params![
                command_id,
                b.key,
                none_to_empty(b.when_ctx.as_deref()),
                none_to_empty(b.scope.as_deref()),
            ])?;
        }
    }
    tx.commit()?;
    Ok(())
}

/// Upsert a command to a single binding (legacy single-binding path).
/// Equivalent to replacing the command's entire binding set with one entry,
/// so callers that predate multi-binding stay correct.
pub fn set_override(o: &KeymapOverride) -> Result<()> {
    set_overrides(&o.command_id, std::slice::from_ref(o))
}

/// Remove a single override. Returns true if a row was removed.
pub fn remove_override(command_id: &str) -> Result<bool> {
    let conn = crate::storage::database::connection();
    let n = conn.execute(
        "DELETE FROM keymap_overrides WHERE command_id = ?1",
        params![command_id],
    )?;
    Ok(n > 0)
}

/// Toggle the disabled flag for a single command.
pub fn set_disabled(command_id: &str, disabled: bool) -> Result<()> {
    let conn = crate::storage::database::connection();
    if disabled {
        conn.execute(
            "INSERT OR IGNORE INTO keymap_disabled (command_id) VALUES (?1)",
            params![command_id],
        )?;
    } else {
        conn.execute(
            "DELETE FROM keymap_disabled WHERE command_id = ?1",
            params![command_id],
        )?;
    }
    Ok(())
}

/// Reset everything to catalog defaults. Drops every override + clears
/// every disabled flag.
pub fn reset_all() -> Result<()> {
    let conn = crate::storage::database::connection();
    conn.execute("DELETE FROM keymap_overrides", [])?;
    conn.execute("DELETE FROM keymap_disabled", [])?;
    Ok(())
}

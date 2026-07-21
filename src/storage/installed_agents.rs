//! Installed agents — the single source of truth for what agents grove can launch.
//!
//! One row per agent (PK: `id`). Multiple install channels can coexist per agent
//! (e.g. claude-acp installed via both `npx` and `binary`); the user picks which
//! channel is active at any time via `selected_install_method`. Per-agent launch
//! mode (`acp` / `terminal`) and user overrides (args, env, hidden) live on the
//! same row.
//!
//! The full per-installation state (version, install_path, status, …) lives in a
//! JSON column `installations`, keeping the SQL schema simple while letting
//! the structure evolve. Same goes for `args_override` and `env_override`.
//!
//! Auto-detect: `auto_scan_path_binaries` walks every registry agent, probes
//! the user's PATH for matching binaries, and upserts an `External`
//! installation channel when found. Channels disappear automatically when the
//! binary leaves PATH. This is uniform across agents — Trae/TraeX get the
//! same treatment as Claude/Codex/Opencode, with no special-case logic.
//! The user CANNOT uninstall an External row through grove (no UI button);
//! removing the binary from PATH is the only way to deregister.

use chrono::{DateTime, Utc};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

use crate::error::Result;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum InstallMethod {
    Npx,
    Binary,
    Uvx,
    /// Agent binary lives on the user's PATH outside grove's installer.
    /// Managed exclusively by `auto_scan_path_binaries` — written when grove
    /// detects the binary on PATH, removed when it disappears. Users cannot
    /// install / uninstall External channels through the UI.
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
    pub fn from_str(s: &str) -> Option<Self> {
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
    #[allow(dead_code)]
    pub fn as_str(&self) -> &'static str {
        match self {
            InstallStatus::Installing => "installing",
            InstallStatus::Installed => "installed",
            InstallStatus::Failed => "failed",
        }
    }
}

/// One install channel's state. The JSON column on `installed_agents` holds
/// a `Vec<Installation>` — an agent can carry multiple channels (npx + binary)
/// installed in parallel.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Installation {
    pub method: InstallMethod,
    pub version: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub install_path: Option<String>,
    pub status: InstallStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub failure_reason: Option<String>,
    pub installed_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InstalledAgent {
    /// Canonical id (e.g. `claude-acp`, `trae`, `traex`).
    pub id: String,
    /// All install channels grove has materialized for this agent. Never empty
    /// for a row that exists (a row with zero installations should be deleted).
    pub installations: Vec<Installation>,
    /// Which entry in `installations` to use when launching. Must correspond to
    /// some `installations[i].method`; helpers validate this on read.
    ///
    /// This single field carries BOTH "where the binary comes from" AND
    /// "how to launch it" — picking `External` for an agent whose registry
    /// entry has `terminal_launch` set implies PTY launch. There is no
    /// separate launch-mode toggle.
    pub selected_install_method: InstallMethod,
    /// User-supplied argv appended after the channel's base args.
    #[serde(default)]
    pub args_override: Vec<String>,
    /// User-supplied env vars merged into the spawn env, overriding registry
    /// channel env on key collision.
    #[serde(default)]
    pub env_override: HashMap<String, String>,
    /// Soft-hide from the picker. The row stays so the user can un-hide.
    pub hidden: bool,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

impl InstalledAgent {
    /// The `Installation` indicated by `selected_install_method`. Falls back
    /// to the first installation if the selection doesn't match anything,
    /// with a stderr warning — the fallback is defensive and should never
    /// fire in steady state.
    ///
    /// Post-v2.6 invariants:
    ///   - migration writes a placeholder for `External` when needed, so
    ///     `selected_install_method` always points at an actual entry.
    ///   - `patch_or_create` rejects invalid selection changes.
    ///   - `remove_installation` re-selects the first remaining channel.
    ///
    /// If the warning ever fires, a code path mutated `installations`
    /// without updating `selected_install_method` — fix that, not this.
    pub fn selected_installation(&self) -> Option<&Installation> {
        let exact = self
            .installations
            .iter()
            .find(|i| i.method == self.selected_install_method);
        if exact.is_some() {
            return exact;
        }
        if let Some(first) = self.installations.first() {
            // Rate-limit the warning: this is on the marketplace / chat
            // hot read path. Logging on every render would spam logs
            // until the underlying writer-bug is fixed. Each unique
            // (agent_id, method-pair) reports once per process.
            warn_selection_drift_once(&self.id, self.selected_install_method, first.method);
            return Some(first);
        }
        None
    }

    /// True if at least one installation is in `Installed` status.
    pub fn has_installed_channel(&self) -> bool {
        self.installations
            .iter()
            .any(|i| i.status == InstallStatus::Installed)
    }
}

fn parse_json<T: for<'a> Deserialize<'a> + Default>(s: Option<String>) -> T {
    s.and_then(|json| serde_json::from_str(&json).ok())
        .unwrap_or_default()
}

fn parse_dt(s: &str) -> DateTime<Utc> {
    DateTime::parse_from_rfc3339(s)
        .map(|dt| dt.with_timezone(&Utc))
        .unwrap_or_else(|_| Utc::now())
}

fn row_to_installed(row: &rusqlite::Row<'_>) -> rusqlite::Result<InstalledAgent> {
    let installations_json: String = row.get(1)?;
    let selected_method: String = row.get(2)?;
    let args_json: Option<String> = row.get(3)?;
    let env_json: Option<String> = row.get(4)?;
    let hidden: i64 = row.get(5)?;
    let created_at: String = row.get(6)?;
    let updated_at: String = row.get(7)?;
    let installations: Vec<Installation> =
        serde_json::from_str(&installations_json).unwrap_or_default();
    Ok(InstalledAgent {
        id: row.get(0)?,
        installations,
        selected_install_method: InstallMethod::from_str(&selected_method)
            .unwrap_or(InstallMethod::Npx),
        args_override: parse_json(args_json),
        env_override: parse_json(env_json),
        hidden: hidden != 0,
        created_at: parse_dt(&created_at),
        updated_at: parse_dt(&updated_at),
    })
}

const COLUMNS: &str = "id, installations, selected_install_method, args_override, env_override, hidden, created_at, updated_at";

pub fn list() -> Result<Vec<InstalledAgent>> {
    let conn = crate::storage::database::connection();
    let mut stmt = conn.prepare(&format!(
        "SELECT {} FROM installed_agents ORDER BY created_at ASC",
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

/// Insert or replace. Caller is responsible for providing a coherent row
/// (at least one installation, selected_install_method matching one of them).
pub fn upsert(agent: &InstalledAgent) -> Result<()> {
    let conn = crate::storage::database::connection();
    let installations_json =
        serde_json::to_string(&agent.installations).unwrap_or_else(|_| "[]".into());
    let args_json = serde_json::to_string(&agent.args_override).unwrap_or_else(|_| "[]".into());
    let env_json = serde_json::to_string(&agent.env_override).unwrap_or_else(|_| "{}".into());
    conn.execute(
        &format!(
            "INSERT INTO installed_agents ({columns})
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
             ON CONFLICT(id) DO UPDATE SET
                 installations           = excluded.installations,
                 selected_install_method = excluded.selected_install_method,
                 args_override           = excluded.args_override,
                 env_override            = excluded.env_override,
                 hidden                  = excluded.hidden,
                 updated_at              = excluded.updated_at",
            columns = COLUMNS
        ),
        params![
            agent.id,
            installations_json,
            agent.selected_install_method.as_str(),
            args_json,
            env_json,
            agent.hidden as i64,
            agent.created_at.to_rfc3339(),
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

/// Add (or upgrade) a single installation channel on an agent. If the agent
/// row doesn't exist yet, creates it with this channel as the selected one
/// and default launch mode. If an installation with the same method already
/// exists, replaces it (re-install / upgrade case).
pub fn add_installation(id: &str, install: Installation) -> Result<InstalledAgent> {
    let now = Utc::now();
    let mut agent = get(id)?.unwrap_or_else(|| InstalledAgent {
        id: id.to_string(),
        installations: Vec::new(),
        selected_install_method: install.method,
        args_override: Vec::new(),
        env_override: HashMap::new(),
        hidden: false,
        created_at: now,
        updated_at: now,
    });
    // Replace existing channel of the same method, else push.
    if let Some(existing) = agent
        .installations
        .iter_mut()
        .find(|i| i.method == install.method)
    {
        *existing = install;
    } else {
        agent.installations.push(install);
    }
    agent.updated_at = now;
    upsert(&agent)?;
    Ok(agent)
}

/// Remove a single installation channel. Deletes the whole agent row if no
/// channels remain. If the removed channel was the `selected_install_method`,
/// re-selects the first remaining channel.
pub fn remove_installation(id: &str, method: InstallMethod) -> Result<Option<InstalledAgent>> {
    let Some(mut agent) = get(id)? else {
        return Ok(None);
    };
    agent.installations.retain(|i| i.method != method);
    if agent.installations.is_empty() {
        delete(id)?;
        return Ok(None);
    }
    if agent.selected_install_method == method {
        agent.selected_install_method = agent.installations[0].method;
    }
    agent.updated_at = Utc::now();
    upsert(&agent)?;
    Ok(Some(agent))
}

/// Patch user-controlled fields. Creates a minimal External row if the agent
/// isn't tracked yet — this is the single entry point for the marketplace
/// per-agent settings sheet so it works uniformly across grove-installed
/// agents, Trae/TraeX path-detected agents, and anything else.
pub fn patch_or_create(
    id: &str,
    selected_install_method: Option<InstallMethod>,
    args_override: Option<Vec<String>>,
    env_override: Option<HashMap<String, String>>,
    hidden: Option<bool>,
) -> Result<InstalledAgent> {
    let now = Utc::now();
    let mut agent = get(id)?.unwrap_or_else(|| InstalledAgent {
        id: id.to_string(),
        installations: vec![Installation {
            method: InstallMethod::External,
            version: String::new(),
            install_path: None,
            status: InstallStatus::Installed,
            failure_reason: None,
            installed_at: now,
        }],
        selected_install_method: InstallMethod::External,
        args_override: Vec::new(),
        env_override: HashMap::new(),
        hidden: false,
        created_at: now,
        updated_at: now,
    });
    if let Some(m) = selected_install_method {
        if !agent.installations.iter().any(|i| i.method == m) {
            // Reject loudly: the channel the caller wants to activate isn't
            // installed. Silently ignoring this used to let the UI radio
            // appear to flip while the backend kept the old selection,
            // producing confusing "I changed channels but launches still
            // use the old one" behaviour.
            return Err(crate::error::GroveError::StorageTagged {
                tag: "channel_not_installed",
                msg: format!(
                    "cannot select install method '{}' for agent '{}' — that channel is not installed",
                    m.as_str(),
                    id,
                ),
            });
        }
        agent.selected_install_method = m;
    }
    if let Some(a) = args_override {
        agent.args_override = a;
    }
    if let Some(e) = env_override {
        agent.env_override = e;
    }
    if let Some(h) = hidden {
        agent.hidden = h;
    }
    agent.updated_at = now;
    upsert(&agent)?;
    Ok(agent)
}

/// Update the status of a specific installation channel. Used by the install
/// handlers to transition installing → installed / failed.
pub fn set_installation_status(
    id: &str,
    method: InstallMethod,
    status: InstallStatus,
    failure_reason: Option<String>,
) -> Result<()> {
    let Some(mut agent) = get(id)? else {
        return Ok(());
    };
    if let Some(install) = agent.installations.iter_mut().find(|i| i.method == method) {
        install.status = status;
        install.failure_reason = failure_reason;
    }
    agent.updated_at = Utc::now();
    upsert(&agent)?;
    Ok(())
}

/// Build the version-pinned package string for `npx -y <pkg>` / `uvx <pkg>`.
///
/// The ACP registry sometimes ships `npx.package` / `uvx.package` already
/// suffixed with `@<version>` (e.g. `@agentclientprotocol/claude-agent-acp@0.44.0`)
/// and sometimes bare (e.g. `opencode`). Re-appending `@<version>` blindly
/// produces malformed `pkg@ver@ver` strings that npx resolves to the wrong
/// package — so we only append when the registry shipped a bare name.
///
/// Detection rule: scoped packages start with `@`, so we only treat an `@`
/// AFTER index 0 as a version suffix delimiter. Bare `pkg@ver` and scoped
/// `@scope/pkg@ver` are both correctly identified.
pub fn pin_package_version(package: &str, version: &str) -> String {
    if version.is_empty() {
        return package.to_string();
    }
    if package.char_indices().skip(1).any(|(_, c)| c == '@') {
        package.to_string()
    } else {
        format!("{}@{}", package, version)
    }
}

/// Resolve the spawn command + args for a launched agent using the selected
/// installation channel. Returns `None` to mean "no launchable channel" —
/// caller treats the agent as unavailable.
///
/// Reads from the agent's `selected_install_method`:
///   - `Npx`/`Uvx`: rebuild `npx -y <pkg>@<version>` (or uvx) using the
///     pinned version from the installation record. Args from the registry's
///     `npx.args` / `uvx.args` ride along.
///   - `Binary`: spawn `install_path` directly. Args from `BinaryTarget.args`.
///     Falls back to `None` if the file has been deleted off disk.
///   - `External`: spawn the agent id as a bare command (Trae writes
///     `install_path=which("traecli")`, so we use that if present; else
///     fall back to PATH lookup via the id).
pub fn spawn_for(
    rec: &InstalledAgent,
    registry_agent: Option<&crate::storage::agent_registry::RegistryAgent>,
) -> Option<(String, Vec<String>)> {
    let install = rec.selected_installation()?;
    if install.status != InstallStatus::Installed {
        return None;
    }
    match install.method {
        InstallMethod::Npx => {
            let reg = registry_agent?;
            let npx = reg.distribution.npx.as_ref()?;
            let pinned = pin_package_version(&npx.package, &install.version);
            let mut args = vec!["-y".to_string(), pinned];
            args.extend(npx.args.iter().cloned());
            Some(("npx".to_string(), args))
        }
        InstallMethod::Uvx => {
            let reg = registry_agent?;
            let uvx = reg.distribution.uvx.as_ref()?;
            let pinned = pin_package_version(&uvx.package, &install.version);
            let mut args = vec![pinned];
            args.extend(uvx.args.iter().cloned());
            Some(("uvx".to_string(), args))
        }
        InstallMethod::Binary => {
            let path = install.install_path.as_ref()?;
            if !std::path::Path::new(path).exists() {
                eprintln!(
                    "[installed_agents] install_path missing for {} — falling back: {}",
                    rec.id, path
                );
                return None;
            }
            let mut args = Vec::new();
            if let Some(reg) = registry_agent {
                let platform = crate::storage::agent_install::current_platform_key();
                if let Some(target) = reg.distribution.binary.get(platform) {
                    args.extend(target.args.iter().cloned());
                }
            }
            Some((path.clone(), args))
        }
        InstallMethod::External => {
            // External rows written by `auto_scan_path_binaries` carry the
            // resolved binary path in install_path; if absent (rare) fall
            // back to PATH lookup by id. Args come from whichever
            // distribution channel's name MATCHES the binary basename —
            // detection and spawn stay symmetric:
            //   binary.<platform>.cmd matches → binary.args
            //   npx.package basename matches → npx.args
            //   uvx.package basename matches → uvx.args
            //   terminal_launch.cmd matches → handled by agent_pty,
            //     spawn returns [] (spawn_for isn't on the PTY path).
            // No match → empty args. We never pull args from an
            // unrelated distribution channel; a `gemini` binary picked up
            // because it happened to share a name with the npx package
            // gets exactly the npx args, never the uvx args.
            let cmd = install
                .install_path
                .clone()
                .unwrap_or_else(|| rec.id.clone());
            let args = registry_agent
                .map(|reg| external_args_for(reg, &cmd))
                .unwrap_or_default();
            Some((cmd, args))
        }
    }
}

/// Boot-time recovery: any installation stuck in `installing` is a crashed
/// install attempt. Mark it failed so the user can retry from Marketplace.
/// Walks every row, updates the JSON-stored installations array in place.
///
/// EXCLUDES `External` channels — those are managed by
/// `auto_scan_path_binaries`, not the install handlers. The v2.5→v2.6
/// migration writes External skeletons with status=Installing; the boot
/// scan replaces them with status=Installed. Flipping them to Failed here
/// would race the scan and surface a transient "Failed" state to users.
pub fn recover_orphaned_installing() -> Result<()> {
    const STALE_AFTER: chrono::Duration = chrono::Duration::minutes(5);
    let cutoff = Utc::now() - STALE_AFTER;
    let rows = list()?;
    for mut agent in rows {
        if agent.updated_at > cutoff {
            continue;
        }
        let mut changed = false;
        for install in &mut agent.installations {
            if install.method == InstallMethod::External {
                continue;
            }
            if install.status == InstallStatus::Installing {
                install.status = InstallStatus::Failed;
                install.failure_reason = Some(
                    "install interrupted (grove exited before download finished); retry from Marketplace"
                        .to_string(),
                );
                changed = true;
            }
        }
        if changed {
            agent.updated_at = Utc::now();
            upsert(&agent)?;
        }
    }
    Ok(())
}

// ─── PATH auto-scan (every registry agent) ───────────────────────────────────

/// Translate a legacy agent id to its current canonical form. Used by chat
/// session reads and any code path that still sees pre-v2.6 ids on disk.
/// Unknown ids pass through unchanged.
///
/// Same table as the `database::migrate_installed_agents_id_remap` rewrites
/// at boot — runtime callers use this as a safety net for stragglers (e.g.
/// chat sessions written before the remap landed).
pub fn canonicalize_agent_id(id: &str) -> String {
    match id {
        "claude" => "claude-acp".to_string(),
        "codex" => "codex-acp".to_string(),
        "cursor-agent" => "cursor".to_string(),
        "gh-copilot" | "copilot" => "github-copilot-cli".to_string(),
        "qwen" => "qwen-code".to_string(),
        other => other.to_string(),
    }
}

/// IDs for the two synthetic ByteDance agents. These match the synthetic
/// registry entries in `agent_registry::inject_trae_and_traex_entries`.
///
/// `traecli` is the historical id grove has used for Trae since the
/// pre-marketplace era — production users already have rows / chat
/// sessions referencing it, so we keep the id rather than rename to a
/// cleaner "trae" (which would require a migration). The PATH binary
/// is also named `traecli`. TraeX is the newer second product, with
/// id and binary both `traex`.
pub const TRAE_ID: &str = "traecli";
pub const TRAEX_ID: &str = "traex";

/// Walk every registry agent, probe PATH for matching binaries, and keep
/// `installed_agents.installations[External]` in sync:
///
///   - PATH match found → upsert an External installation pointing at the
///     resolved absolute path (+ version).
///   - PATH match disappeared → remove the External channel (uniform across
///     all agents; no special-case for Trae/TraeX). The whole row is dropped
///     when External was the only channel.
///
/// User-installed channels (Npx / Binary / Uvx) are NEVER touched — only
/// the External channel is auto-managed. So a user who clicked Install on
/// claude-acp via Npx keeps that Npx row even if claude is also on PATH;
/// they end up with both channels and can switch via `selected_install_method`.
///
/// Cheap — `command_exists` is just a PATH stat. No `--version` probing
/// (External channels only need the resolved path to spawn); the TTL
/// cache below keeps repeated calls trivially fast.
pub fn auto_scan_path_binaries(
    registry: &crate::storage::agent_registry::RegistryDocument,
) -> Result<()> {
    // TTL cache: Marketplace renders re-trigger this scan; within the TTL
    // window we skip — the user's PATH doesn't change between rapid
    // renders. The first call after the TTL expires (or after grove
    // restart) does the work fresh. NOTE: timestamp is stamped at the
    // END of the function so a mid-scan error doesn't poison the cache
    // and silence retries for 30s.
    //
    // Lock poisoning (panic while holding the mutex) is treated as
    // "cache miss" — we don't want a stray panic to permanently break
    // the scan path. Same pattern on the write side below.
    if let Ok(last) = LAST_SCAN.lock() {
        if let Some(t) = *last {
            if t.elapsed() < std::time::Duration::from_secs(30) {
                return Ok(());
            }
        }
    }

    use std::collections::HashSet;
    let now = Utc::now();
    let mut detected_agent_ids: HashSet<String> = HashSet::new();

    for reg in &registry.agents {
        // Fast path: an existing External row tells us the previously-
        // resolved binary. If its path still exists on disk we trust it
        // and skip the binary probe (which would spawn `--version` and
        // wait up to 500ms). New PATH binaries are picked up on the next
        // miss; that's the cost of the optimization and it's fine because
        // (a) users rarely install new agent CLIs mid-session, and (b)
        // the existing row is still correct in the meantime.
        let existing = get(&reg.id)?;
        let cached_external = existing.as_ref().and_then(|a| {
            a.installations
                .iter()
                .find(|i| i.method == InstallMethod::External)
        });
        if let Some(cached) = cached_external {
            if let Some(path) = cached.install_path.as_deref() {
                // The file existing is insufficient: PATH may have changed
                // since the previous scan (shell profile, GUI environment,
                // version manager, etc.). Trust the cache only when resolving
                // the same binary name in the current environment still lands
                // on the persisted path.
                let still_on_path = std::path::Path::new(path)
                    .file_name()
                    .and_then(|name| name.to_str())
                    .and_then(crate::check::resolve_program)
                    .is_some_and(|resolved| resolved == std::path::Path::new(path));
                if still_on_path {
                    detected_agent_ids.insert(reg.id.clone());
                    continue;
                }
            }
        }

        let Some((cmd, resolved)) = probe_registry_agent(reg) else {
            continue;
        };
        detected_agent_ids.insert(reg.id.clone());

        let already_matches = existing.as_ref().is_some_and(|a| {
            a.installations.iter().any(|i| {
                i.method == InstallMethod::External
                    && i.install_path == resolved
                    && i.status == InstallStatus::Installed
            })
        });
        if already_matches {
            continue;
        }

        let install = Installation {
            method: InstallMethod::External,
            // External rows carry an empty version — version is only
            // meaningful for grove-installed channels (npx/binary/uvx)
            // where we know the pinned version. UI hides empty versions.
            version: String::new(),
            install_path: resolved.or(Some(cmd)),
            status: InstallStatus::Installed,
            failure_reason: None,
            installed_at: existing
                .as_ref()
                .and_then(|a| {
                    a.installations
                        .iter()
                        .find(|i| i.method == InstallMethod::External)
                        .map(|i| i.installed_at)
                })
                .unwrap_or(now),
        };
        add_installation(&reg.id, install)?;
    }

    // Deregister: any row whose binary disappeared from PATH loses its
    // External channel. Walks ALL installed_agents rows (including ones
    // that aren't in the current registry — orphans get their External
    // channel cleared the same way).
    let rows = list()?;
    for mut agent in rows {
        if detected_agent_ids.contains(&agent.id) {
            continue;
        }
        let has_external = agent
            .installations
            .iter()
            .any(|i| i.method == InstallMethod::External);
        if !has_external {
            continue;
        }
        // If External wasn't the user's selected channel, just drop it
        // (the user wasn't relying on it; quiet cleanup).
        if agent.selected_install_method != InstallMethod::External {
            remove_installation(&agent.id, InstallMethod::External)?;
            continue;
        }
        // External WAS the selected channel — silently switching the
        // user to a different channel (Round 3 #1 finding) confuses
        // anyone who chose "Auto Detected / Terminal" mode. Instead:
        //   - if there's no other channel to fall back to, just delete
        //     (row would otherwise be unlaunchable).
        //   - if there IS another channel, mark External as Failed with
        //     a clear reason so the UI shows the broken state and the
        //     user knows their selection was undermined by PATH state.
        let has_other_channel = agent
            .installations
            .iter()
            .any(|i| i.method != InstallMethod::External);
        if !has_other_channel {
            remove_installation(&agent.id, InstallMethod::External)?;
            continue;
        }
        let mut changed = false;
        for install in &mut agent.installations {
            if install.method == InstallMethod::External && install.status != InstallStatus::Failed
            {
                install.status = InstallStatus::Failed;
                install.failure_reason = Some(
                    "binary no longer on PATH — install it (or re-add to PATH) to restore"
                        .to_string(),
                );
                install.install_path = None;
                changed = true;
            }
        }
        if changed {
            agent.updated_at = Utc::now();
            upsert(&agent)?;
        }
    }

    // Stamp the TTL ONLY after a successful run. If we errored above
    // (returned via `?`), the timestamp stays at its previous value so
    // the next caller retries fresh instead of silently skipping for
    // 30s.
    if let Ok(mut last) = LAST_SCAN.lock() {
        *last = Some(std::time::Instant::now());
    }
    Ok(())
}

/// TTL cache for `auto_scan_path_binaries`. Stamped with the wall-clock
/// instant of the last completed scan; we skip if the previous run was
/// less than 30 seconds ago. Manual `Refresh` in Marketplace (which calls
/// `reset_auto_scan_cache`) forces a fresh probe.
static LAST_SCAN: once_cell::sync::Lazy<std::sync::Mutex<Option<std::time::Instant>>> =
    once_cell::sync::Lazy::new(|| std::sync::Mutex::new(None));

/// Reset the scan TTL — call from explicit "refresh now" paths (e.g.
/// `marketplace::refresh_registry`) so the user's manual click always
/// produces fresh data.
pub fn reset_auto_scan_cache() {
    if let Ok(mut guard) = LAST_SCAN.lock() {
        *guard = None;
    }
}

/// Apply the complete startup agent state transition against one registry
/// snapshot. Keeping this orchestration outside the HTTP/server layer lets
/// startup and integration tests exercise the exact same DB-writing path.
pub fn reconcile_registry_state(
    registry: &crate::storage::agent_registry::RegistryDocument,
) -> Result<usize> {
    let added = reconcile_onboarding_agents(registry)?;
    refresh_path_installations(registry)?;
    Ok(added)
}

/// Force a fresh local-environment scan for an already-resolved registry.
/// Marketplace Refresh and startup both use this entry point so TTL behavior
/// cannot make their persisted state differ.
pub fn refresh_path_installations(
    registry: &crate::storage::agent_registry::RegistryDocument,
) -> Result<()> {
    reset_auto_scan_cache();
    auto_scan_path_binaries(registry)
}

/// One-warning-per-(id, methods) cache for `selected_installation`'s drift
/// fallback. Selection drift indicates a writer-path bug; we want it
/// audible without spamming the hot read path.
static SELECTION_DRIFT_SEEN: once_cell::sync::Lazy<
    std::sync::Mutex<std::collections::HashSet<(String, InstallMethod, InstallMethod)>>,
> = once_cell::sync::Lazy::new(|| std::sync::Mutex::new(std::collections::HashSet::new()));

fn warn_selection_drift_once(id: &str, selected: InstallMethod, fallback: InstallMethod) {
    let key = (id.to_string(), selected, fallback);
    if let Ok(mut seen) = SELECTION_DRIFT_SEEN.lock() {
        if !seen.insert(key) {
            return;
        }
    }
    eprintln!(
        "[installed_agents] selection drift for {}: selected_install_method={:?} \
         has no matching installation; falling back to {:?}. This indicates a bug \
         in the writer path — installation list was mutated without updating the selection.",
        id, selected, fallback,
    );
}

/// Probe the user's PATH for any binary name this registry agent would
/// answer to. Returns `(command, resolved_path)` on first hit.
///
/// Probe order, first match wins. Each candidate is tied to a known
/// distribution declaration — we deliberately do NOT fall back to
/// `reg.id` (e.g. a stray `gemini` script on PATH unrelated to
/// `@google/gemini-cli` would otherwise hijack the External slot).
///
///   1. `distribution.binary.<platform>.cmd` — explicit binary
///      distribution's executable name. Covers Trae/TraeX (synthetic
///      entries with binary.cmd set).
///   2. `distribution.npx.package` basename — covers users who ran
///      `npm install -g <pkg>`. By npm convention the bin has the same
///      name as the package basename; if the upstream package ships a
///      differently-named bin (rare) we don't auto-detect, the user can
///      still install via npx through the Marketplace.
///   3. `distribution.uvx.package` basename — same idea for
///      `uv tool install <pkg>` / pipx.
///   4. `terminal_launch.cmd` — grove-only PTY launch binary (claude).
pub fn probe_registry_agent(
    reg: &crate::storage::agent_registry::RegistryAgent,
) -> Option<(String, Option<String>)> {
    let platform = crate::storage::agent_install::current_platform_key();
    let mut candidates: Vec<String> = Vec::new();
    let mut push = |s: String| {
        if !s.is_empty() && !s.contains('/') && !s.contains('\\') && !candidates.contains(&s) {
            candidates.push(s);
        }
    };

    if let Some(target) = reg.distribution.binary.get(platform) {
        push(target.cmd.trim_start_matches("./").to_string());
    }
    if let Some(npx) = reg.distribution.npx.as_ref() {
        push(package_to_binary_name(&npx.package));
    }
    if let Some(uvx) = reg.distribution.uvx.as_ref() {
        push(package_to_binary_name(&uvx.package));
    }
    // grove-only: PTY launch binary (e.g. claude-acp probes for `claude`).
    if let Some(t) = reg.terminal_launch.as_ref() {
        push(t.cmd.clone());
    }
    // NOTE: deliberately no `reg.id` fallback — see doc comment above. We
    // only auto-register when a binary name is declared by SOME
    // distribution channel; a stray same-named script on PATH that isn't
    // the agent we think it is would otherwise hijack the slot AND get
    // launched without the right ACP-mode flags.

    for cmd in candidates {
        if !crate::check::command_exists(&cmd) {
            continue;
        }
        let resolved = crate::check::resolve_program(&cmd).map(|p| p.to_string_lossy().to_string());
        // No `--version` probe here. Version is display-only for External
        // channels (spawn flow only needs the path + registry-side argv),
        // and probing would block up to 500ms per detected binary across
        // every Marketplace render. UI hides empty version automatically.
        return Some((cmd, resolved));
    }
    None
}

/// Strip a package spec down to the bare CLI binary name.
///
/// Handles the four shapes the registry actually ships:
///   - `opencode` → `opencode`
///   - `opencode@1.2.3` → `opencode`
///   - `@scope/foo-cli` → `foo-cli`
///   - `@scope/foo-cli@1.2.3` → `foo-cli`
fn package_to_binary_name(package: &str) -> String {
    let after_scope = if let Some(rest) = package.strip_prefix('@') {
        rest.split_once('/').map(|(_, r)| r).unwrap_or(rest)
    } else {
        package
    };
    after_scope
        .split_once('@')
        .map(|(name, _)| name)
        .unwrap_or(after_scope)
        .to_string()
}

/// Look up the right argv for an External-installed binary by matching the
/// resolved binary basename against each declared distribution channel and
/// returning that channel's args.
///
/// This keeps detection and spawn symmetric: probe_registry_agent enumerates
/// candidates from each channel (binary.cmd, npx package basename, uvx
/// package basename, terminal_launch.cmd) and stops at the first PATH hit;
/// we re-do the same match here against the stored install_path to recover
/// which channel produced the hit, and pull args from that channel.
///
/// Why re-derive instead of storing the channel on the Installation row?
/// Avoids a schema change for what's effectively a fast string comparison
/// at spawn time. If the registry distribution shape changes between
/// detection and spawn, we just fall through to empty args — no stale
/// stored value to invalidate.
fn external_args_for(
    reg: &crate::storage::agent_registry::RegistryAgent,
    install_path: &str,
) -> Vec<String> {
    let bin_name = std::path::Path::new(install_path)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or(install_path);

    let platform = crate::storage::agent_install::current_platform_key();
    if let Some(target) = reg.distribution.binary.get(platform) {
        if target.cmd.trim_start_matches("./") == bin_name {
            return target.args.clone();
        }
    }
    if let Some(npx) = reg.distribution.npx.as_ref() {
        if package_to_binary_name(&npx.package) == bin_name {
            return npx.args.clone();
        }
    }
    if let Some(uvx) = reg.distribution.uvx.as_ref() {
        if package_to_binary_name(&uvx.package) == bin_name {
            return uvx.args.clone();
        }
    }
    // terminal_launch.cmd hits don't go through spawn_for — agent_pty
    // handles them. Reachable only if the user's selected_install_method
    // is External on a terminal-capable agent and they bypassed the PTY
    // route somehow. Return empty rather than guess.
    Vec::new()
}

fn external_env_for(
    reg: &crate::storage::agent_registry::RegistryAgent,
    install_path: &str,
) -> HashMap<String, String> {
    let bin_name = std::path::Path::new(install_path)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or(install_path);
    let platform = crate::storage::agent_install::current_platform_key();
    if let Some(target) = reg.distribution.binary.get(platform) {
        if target.cmd.trim_start_matches("./") == bin_name {
            return target.env.clone();
        }
    }
    if let Some(npx) = reg.distribution.npx.as_ref() {
        if package_to_binary_name(&npx.package) == bin_name {
            return npx.env.clone();
        }
    }
    if let Some(uvx) = reg.distribution.uvx.as_ref() {
        if package_to_binary_name(&uvx.package) == bin_name {
            return uvx.env.clone();
        }
    }
    HashMap::new()
}

/// Resolve the registry-provided environment for the selected channel and
/// merge the user's persisted overrides. This is the canonical launch-env
/// path used by ACP startup and by integration tests.
pub fn launch_env_for(
    rec: &InstalledAgent,
    reg: &crate::storage::agent_registry::RegistryAgent,
) -> HashMap<String, String> {
    let mut env = match rec.selected_install_method {
        InstallMethod::Npx => reg
            .distribution
            .npx
            .as_ref()
            .map(|distribution| distribution.env.clone())
            .unwrap_or_default(),
        InstallMethod::Uvx => reg
            .distribution
            .uvx
            .as_ref()
            .map(|distribution| distribution.env.clone())
            .unwrap_or_default(),
        InstallMethod::Binary => reg
            .distribution
            .binary
            .get(crate::storage::agent_install::current_platform_key())
            .map(|target| target.env.clone())
            .unwrap_or_default(),
        InstallMethod::External => rec
            .selected_installation()
            .and_then(|installation| installation.install_path.as_deref())
            .map(|path| external_env_for(reg, path))
            .unwrap_or_default(),
    };
    env.extend(rec.env_override.clone());
    env
}

// ─── Onboarding agent reconciliation ────────────────────────────────────────

/// Boot-time onboarding reconciliation: ensure every product-owned onboarding
/// agent has an Npx installation channel. Package metadata is resolved from
/// the registry; only the four canonical ids are owned by grove.
///
/// Why this exists: pre-refactor grove allowed users to launch builtin
/// agents (claude / codex / gemini / opencode / copilot / qwen) without
/// ever creating an `installed_agents` row, via the now-deleted
/// `BUILTIN_ACP_AGENTS` resolver. After the refactor, `resolve_agent`
/// requires a row. Without this seed, an upgrading user whose chats
/// referenced those ids would hit "Unknown agent" — a "previously-used
/// agent suddenly gone" regression.
///
/// Gate is per-CHANNEL, not per-ROW. On a machine where a local binary has
/// already produced an External channel, reconciliation still adds Npx. The
/// startup caller now awaits this function before exposing the server.
///
/// Behaviour:
///   - No gate on row count / remap audit; safe to call on every boot.
///   - Adds the Npx channel ONE-BY-ONE only when missing.
///   - Moves Claude from the historical External selection to Npx while
///     retaining External data for old terminal chats.
///   - Rejects a partial registry before writing any channels.
pub fn reconcile_onboarding_agents(
    registry_doc: &crate::storage::agent_registry::RegistryDocument,
) -> Result<usize> {
    // Validate the complete registry contract before writing anything. A
    // partial registry must not produce a partially initialized onboarding
    // state that the rest of startup mistakes for success.
    let mut registry_agents = Vec::new();
    for id in crate::storage::curated_agents::onboarding_agent_ids() {
        let reg = registry_doc
            .agents
            .iter()
            .find(|agent| agent.id == *id)
            .ok_or_else(|| {
                crate::error::GroveError::storage(format!(
                    "onboarding agent '{}' missing from ACP registry",
                    id
                ))
            })?;
        if reg.distribution.npx.is_none() {
            return Err(crate::error::GroveError::storage(format!(
                "onboarding agent '{}' has no npx distribution in ACP registry",
                id
            )));
        }
        registry_agents.push((*id, reg));
    }

    let now = Utc::now();
    let mut seeded = 0usize;
    for (id, reg) in registry_agents {
        let existing = get(id)?;
        let has_npx = existing.as_ref().is_some_and(|a| {
            a.installations
                .iter()
                .any(|i| i.method == InstallMethod::Npx)
        });
        if has_npx {
            // Claude Terminal remains implemented for historical chats, but
            // it is no longer a selectable product mode. Converge upgraded
            // users onto the existing Npx channel without deleting External.
            if id == "claude-acp"
                && existing
                    .as_ref()
                    .is_some_and(|a| a.selected_install_method == InstallMethod::External)
            {
                patch_or_create(id, Some(InstallMethod::Npx), None, None, None)?;
            }
            continue;
        }
        let install = Installation {
            method: InstallMethod::Npx,
            version: reg.version.clone(),
            install_path: None,
            status: InstallStatus::Installed,
            failure_reason: None,
            installed_at: now,
        };
        add_installation(id, install)?;
        if id == "claude-acp" {
            patch_or_create(id, Some(InstallMethod::Npx), None, None, None)?;
        }
        seeded += 1;
    }
    Ok(seeded)
}

#[cfg(test)]
mod tests {
    use super::*;

    struct PathGuard(Option<std::ffi::OsString>);

    impl PathGuard {
        fn set(path: &std::path::Path) -> Self {
            let previous = std::env::var_os("PATH");
            // SAFETY: DB/environment integration tests are serialized by the
            // process-wide test lock and restore PATH in Drop.
            unsafe { std::env::set_var("PATH", path) };
            Self(previous)
        }
    }

    impl Drop for PathGuard {
        fn drop(&mut self) {
            // SAFETY: see PathGuard::set.
            unsafe {
                match self.0.take() {
                    Some(path) => std::env::set_var("PATH", path),
                    None => std::env::remove_var("PATH"),
                }
            }
        }
    }

    #[cfg(unix)]
    fn make_executable(path: &std::path::Path) {
        use std::os::unix::fs::PermissionsExt;
        std::fs::write(path, "#!/bin/sh\nexit 0\n").unwrap();
        let mut permissions = std::fs::metadata(path).unwrap().permissions();
        permissions.set_mode(0o755);
        std::fs::set_permissions(path, permissions).unwrap();
    }

    fn fresh_npx(id: &str) -> InstalledAgent {
        let now = Utc::now();
        InstalledAgent {
            id: id.to_string(),
            installations: vec![Installation {
                method: InstallMethod::Npx,
                version: "1.0.0".into(),
                install_path: None,
                status: InstallStatus::Installed,
                failure_reason: None,
                installed_at: now,
            }],
            selected_install_method: InstallMethod::Npx,
            args_override: vec![],
            env_override: HashMap::new(),
            hidden: false,
            created_at: now,
            updated_at: now,
        }
    }

    #[test]
    fn pin_package_version_handles_registry_shapes() {
        assert_eq!(
            pin_package_version("@agentclientprotocol/claude-agent-acp@0.44.0", "0.44.0"),
            "@agentclientprotocol/claude-agent-acp@0.44.0",
        );
        assert_eq!(pin_package_version("opencode", "1.17.3"), "opencode@1.17.3");
        assert_eq!(
            pin_package_version("@zed-industries/codex-acp", "0.16.0"),
            "@zed-industries/codex-acp@0.16.0",
        );
        assert_eq!(pin_package_version("opencode", ""), "opencode");
    }

    #[test]
    fn selected_installation_picks_active_channel() {
        let mut agent = fresh_npx("claude-acp");
        agent.installations.push(Installation {
            method: InstallMethod::Binary,
            version: "0.5.0".into(),
            install_path: Some("/tmp/claude".into()),
            status: InstallStatus::Installed,
            failure_reason: None,
            installed_at: Utc::now(),
        });
        agent.selected_install_method = InstallMethod::Binary;
        let picked = agent.selected_installation().unwrap();
        assert_eq!(picked.method, InstallMethod::Binary);
        assert_eq!(picked.version, "0.5.0");
    }

    #[test]
    fn selected_installation_falls_back_when_selection_missing() {
        let mut agent = fresh_npx("claude-acp");
        // Selection points at a method that no longer exists in installations.
        agent.selected_install_method = InstallMethod::Binary;
        let picked = agent.selected_installation().unwrap();
        // Falls back to the first installation we DO have.
        assert_eq!(picked.method, InstallMethod::Npx);
    }

    #[tokio::test]
    async fn upsert_get_delete_roundtrip() {
        let _l = crate::storage::database::test_lock().lock().await;
        let temp = tempfile::tempdir().unwrap();
        crate::storage::set_grove_dir_override(Some(temp.path().to_path_buf()));

        upsert(&fresh_npx("claude-acp")).unwrap();
        let got = get("claude-acp").unwrap().unwrap();
        assert_eq!(got.installations.len(), 1);
        assert_eq!(got.selected_install_method, InstallMethod::Npx);

        let removed = delete("claude-acp").unwrap();
        assert!(removed);
        assert!(get("claude-acp").unwrap().is_none());

        crate::storage::set_grove_dir_override(None);
    }

    #[tokio::test]
    async fn add_remove_installation_keeps_selection_coherent() {
        let _l = crate::storage::database::test_lock().lock().await;
        let temp = tempfile::tempdir().unwrap();
        crate::storage::set_grove_dir_override(Some(temp.path().to_path_buf()));

        let now = Utc::now();
        // Start with Npx.
        upsert(&fresh_npx("claude-acp")).unwrap();
        // Add a Binary channel.
        let binary_install = Installation {
            method: InstallMethod::Binary,
            version: "2.0.0".into(),
            install_path: Some("/tmp/claude".into()),
            status: InstallStatus::Installed,
            failure_reason: None,
            installed_at: now,
        };
        add_installation("claude-acp", binary_install).unwrap();
        let got = get("claude-acp").unwrap().unwrap();
        assert_eq!(got.installations.len(), 2);
        // selected_install_method unchanged.
        assert_eq!(got.selected_install_method, InstallMethod::Npx);

        // Remove the non-selected channel → selection still valid.
        remove_installation("claude-acp", InstallMethod::Binary).unwrap();
        let got = get("claude-acp").unwrap().unwrap();
        assert_eq!(got.installations.len(), 1);
        assert_eq!(got.selected_install_method, InstallMethod::Npx);

        // Remove the last channel → row deleted.
        remove_installation("claude-acp", InstallMethod::Npx).unwrap();
        assert!(get("claude-acp").unwrap().is_none());

        crate::storage::set_grove_dir_override(None);
    }

    #[tokio::test]
    async fn patch_only_specified_fields() {
        let _l = crate::storage::database::test_lock().lock().await;
        let temp = tempfile::tempdir().unwrap();
        crate::storage::set_grove_dir_override(Some(temp.path().to_path_buf()));

        let mut agent = fresh_npx("codex-acp");
        agent.args_override = vec!["--foo".into()];
        upsert(&agent).unwrap();

        let updated =
            patch_or_create("codex-acp", None, Some(vec!["--bar".into()]), None, None).unwrap();
        assert_eq!(updated.args_override, vec!["--bar".to_string()]);

        crate::storage::set_grove_dir_override(None);
    }

    fn onboarding_registry() -> crate::storage::agent_registry::RegistryDocument {
        use crate::storage::agent_registry::{Distribution, NpxDistribution, RegistryAgent};
        crate::storage::agent_registry::RegistryDocument {
            version: "1".into(),
            agents: crate::storage::curated_agents::onboarding_agent_ids()
                .iter()
                .map(|id| RegistryAgent {
                    id: (*id).to_string(),
                    name: (*id).to_string(),
                    version: "1.0.0".into(),
                    description: String::new(),
                    repository: None,
                    website: None,
                    authors: Vec::new(),
                    license: None,
                    icon: None,
                    distribution: Distribution {
                        npx: Some(NpxDistribution {
                            package: format!("@example/{}", id),
                            args: Vec::new(),
                            env: HashMap::new(),
                        }),
                        ..Default::default()
                    },
                    terminal_launch: None,
                })
                .collect(),
        }
    }

    /// Regression test: an upgraded Claude user may have only the historical
    /// External/Terminal channel. Startup must add Npx and make it active.
    #[tokio::test]
    async fn seed_adds_npx_even_when_external_row_already_exists() {
        let _l = crate::storage::database::test_lock().lock().await;
        let temp = tempfile::tempdir().unwrap();
        crate::storage::set_grove_dir_override(Some(temp.path().to_path_buf()));

        // Simulate the PATH scan having already run and written an
        // External-only row for a curated agent id.
        let now = Utc::now();
        add_installation(
            "claude-acp",
            Installation {
                method: InstallMethod::External,
                version: String::new(),
                install_path: Some("/usr/local/bin/claude".into()),
                status: InstallStatus::Installed,
                failure_reason: None,
                installed_at: now,
            },
        )
        .unwrap();

        let registry = onboarding_registry();
        let seeded = reconcile_onboarding_agents(&registry).unwrap();
        assert_eq!(seeded, 4);

        let agent = get("claude-acp").unwrap().unwrap();
        assert!(agent
            .installations
            .iter()
            .any(|i| i.method == InstallMethod::Npx));
        assert!(agent
            .installations
            .iter()
            .any(|i| i.method == InstallMethod::External));
        assert_eq!(agent.selected_install_method, InstallMethod::Npx);

        for id in crate::storage::curated_agents::onboarding_agent_ids() {
            let installed = get(id).unwrap().unwrap();
            assert!(installed
                .installations
                .iter()
                .any(|i| i.method == InstallMethod::Npx));
        }
        assert!(get("gemini").unwrap().is_none());

        // Idempotent: running again seeds nothing further.
        let seeded_again = reconcile_onboarding_agents(&registry).unwrap();
        assert_eq!(seeded_again, 0);

        crate::storage::set_grove_dir_override(None);
    }

    #[tokio::test]
    async fn onboarding_rejects_partial_registry_before_writing() {
        let _l = crate::storage::database::test_lock().lock().await;
        let temp = tempfile::tempdir().unwrap();
        crate::storage::set_grove_dir_override(Some(temp.path().to_path_buf()));

        let mut registry = onboarding_registry();
        registry.agents.retain(|agent| agent.id != "qwen-code");
        let err = reconcile_onboarding_agents(&registry).unwrap_err();
        assert!(err.to_string().contains("qwen-code"));
        assert!(list().unwrap().is_empty());

        crate::storage::set_grove_dir_override(None);
    }

    /// Full startup data path: cached Registry -> startup reconciliation ->
    /// raw SQLite rows. No Marketplace handler or install endpoint is called.
    #[cfg(unix)]
    #[tokio::test]
    async fn startup_registry_cache_reconciles_four_agents_into_sqlite() {
        let _l = crate::storage::database::test_lock().lock().await;
        let temp = tempfile::tempdir().unwrap();
        crate::storage::set_grove_dir_override(Some(temp.path().to_path_buf()));
        let empty_path = tempfile::tempdir().unwrap();
        let _path = PathGuard::set(empty_path.path());

        let registry = onboarding_registry();
        let registry_dir = temp.path().join("registry");
        std::fs::create_dir_all(&registry_dir).unwrap();
        std::fs::write(
            registry_dir.join("registry.json"),
            serde_json::to_vec_pretty(&registry).unwrap(),
        )
        .unwrap();

        let cached = crate::storage::agent_registry::get_for_auto_install()
            .await
            .unwrap();
        assert_eq!(reconcile_registry_state(&cached).unwrap(), 4);

        let conn = crate::storage::database::connection();
        let mut stmt = conn
            .prepare(
                "SELECT id, installations, selected_install_method \
                 FROM installed_agents ORDER BY id",
            )
            .unwrap();
        let rows = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })
            .unwrap()
            .collect::<std::result::Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(rows.len(), 4);
        for (id, installations_json, selected) in rows {
            assert!(crate::storage::curated_agents::onboarding_agent_ids().contains(&id.as_str()));
            assert_eq!(selected, "npx");
            let installations: Vec<Installation> =
                serde_json::from_str(&installations_json).unwrap();
            assert_eq!(installations.len(), 1);
            assert_eq!(installations[0].method, InstallMethod::Npx);
            assert_eq!(installations[0].version, "1.0.0");
        }

        drop(stmt);
        drop(conn);
        crate::storage::set_grove_dir_override(None);
    }

    /// Full refresh data path: different PATH environments must be reflected
    /// in persisted External channels, including removal and path replacement.
    #[cfg(unix)]
    #[tokio::test]
    async fn refresh_path_environment_updates_external_channels_in_sqlite() {
        use crate::storage::agent_registry::{Distribution, NpxDistribution, RegistryAgent};

        let _l = crate::storage::database::test_lock().lock().await;
        let temp = tempfile::tempdir().unwrap();
        crate::storage::set_grove_dir_override(Some(temp.path().to_path_buf()));

        let mut registry = onboarding_registry();
        registry.agents.push(RegistryAgent {
            id: "local-fixture-agent".into(),
            name: "Local fixture agent".into(),
            version: "9.9.9".into(),
            description: String::new(),
            repository: None,
            website: None,
            authors: Vec::new(),
            license: None,
            icon: None,
            distribution: Distribution {
                npx: Some(NpxDistribution {
                    package: "local-fixture-agent".into(),
                    args: vec!["--acp".into()],
                    env: HashMap::from([("REGISTRY_TOKEN".into(), "registry-value".into())]),
                }),
                ..Default::default()
            },
            terminal_launch: None,
        });

        let path_a = tempfile::tempdir().unwrap();
        let binary_a = path_a.path().join("local-fixture-agent");
        make_executable(&binary_a);
        {
            let _path = PathGuard::set(path_a.path());
            reconcile_registry_state(&registry).unwrap();
        }

        let raw_installations = {
            let conn = crate::storage::database::connection();
            conn.query_row(
                "SELECT installations FROM installed_agents WHERE id = 'local-fixture-agent'",
                [],
                |row| row.get::<_, String>(0),
            )
            .unwrap()
        };
        let installations: Vec<Installation> = serde_json::from_str(&raw_installations).unwrap();
        assert_eq!(installations.len(), 1);
        assert_eq!(installations[0].method, InstallMethod::External);
        assert_eq!(installations[0].install_path.as_deref(), binary_a.to_str());

        // Registry env is resolved from the distribution that produced the
        // External binary; user overrides are persisted in SQLite and win.
        patch_or_create(
            "local-fixture-agent",
            None,
            None,
            Some(HashMap::from([
                ("REGISTRY_TOKEN".into(), "user-value".into()),
                ("USER_ONLY".into(), "present".into()),
            ])),
            None,
        )
        .unwrap();
        let rec = get("local-fixture-agent").unwrap().unwrap();
        let effective_env = launch_env_for(&rec, registry.agents.last().unwrap());
        assert_eq!(effective_env.get("REGISTRY_TOKEN").unwrap(), "user-value");
        assert_eq!(effective_env.get("USER_ONLY").unwrap(), "present");
        let raw_env_override: String = crate::storage::database::connection()
            .query_row(
                "SELECT env_override FROM installed_agents WHERE id = 'local-fixture-agent'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            serde_json::from_str::<HashMap<String, String>>(&raw_env_override)
                .unwrap()
                .get("REGISTRY_TOKEN")
                .unwrap(),
            "user-value"
        );

        // A new process environment points at a different copy. Refresh must
        // update SQLite even though the old executable still exists on disk.
        let path_b = tempfile::tempdir().unwrap();
        let binary_b = path_b.path().join("local-fixture-agent");
        make_executable(&binary_b);
        {
            let _path = PathGuard::set(path_b.path());
            refresh_path_installations(&registry).unwrap();
        }
        assert_eq!(
            get("local-fixture-agent").unwrap().unwrap().installations[0]
                .install_path
                .as_deref(),
            binary_b.to_str()
        );

        // Removing the binary from PATH removes the auto-managed DB row.
        let empty_path = tempfile::tempdir().unwrap();
        {
            let _path = PathGuard::set(empty_path.path());
            refresh_path_installations(&registry).unwrap();
        }
        assert!(get("local-fixture-agent").unwrap().is_none());
        // User-managed onboarding channels survive local-environment refresh.
        for id in crate::storage::curated_agents::onboarding_agent_ids() {
            assert!(get(id).unwrap().is_some());
        }

        crate::storage::set_grove_dir_override(None);
    }
}

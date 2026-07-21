//! Marketplace HTTP handlers.
//!
//! Single source of truth for the agent UX:
//!   * Catalog (Explore) = registry CDN + two synthetic entries (`traecli`,
//!     `traex`) injected by `agent_registry::get()`.
//!   * Installed = rows in the `installed_agents` SQLite table, kept in sync
//!     by `installed_agents::auto_scan_path_binaries()` which walks every
//!     registry agent and registers / deregisters External installations
//!     based on PATH presence.
//!
//! `install_state` is derived strictly from whether/how the row exists.

use axum::{
    extract::{Path, Query},
    http::StatusCode,
    response::IntoResponse,
    Json,
};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

use crate::storage::agent_registry::{
    self, BinaryTarget, NpxDistribution, RegistryAgent, UvxDistribution,
};
use crate::storage::installed_agents::{
    self, InstallMethod, InstallStatus, Installation, InstalledAgent,
};

// ─── Response DTOs ───────────────────────────────────────────────────────────

#[derive(Debug, Serialize)]
pub struct MarketplaceAgent {
    pub id: String,
    pub name: String,
    pub description: String,
    pub version: Option<String>,
    pub repository: Option<String>,
    pub website: Option<String>,
    pub authors: Vec<String>,
    pub license: Option<String>,
    /// Icon URL from the registry CDN. None for synthetic Trae/TraeX (the
    /// frontend renders a placeholder when no URL is present — we'll wire
    /// grove-served Trae assets in a follow-up).
    pub icon_url: Option<String>,
    /// Channels the user can install via. Derived from the registry's
    /// `distribution` map; ordered as `npx`, `binary`, `uvx` when present.
    pub available_install_methods: Vec<InstallMethod>,
    /// True when this agent's registry entry has a `terminal_launch`
    /// config — i.e. picking the External channel will spawn the agent
    /// via PTY using grove's terminal contract. Currently true only for
    /// claude-acp (via `inject_grove_supplements`).
    pub supports_terminal_launch: bool,
    /// One of: `grove-installed` | `auto-detected` | `installing` |
    /// `install-failed` | `not-installed`.
    pub install_state: &'static str,
    /// Per-channel installation records + selections. None when no
    /// `installed_agents` row exists.
    pub installed: Option<InstalledAgentView>,
    /// Resolved binary view for the active installation. Populated for
    /// auto-detected and Binary-installed channels.
    pub binary: Option<BinaryView>,
}

#[derive(Debug, Serialize)]
pub struct InstalledAgentView {
    pub installations: Vec<Installation>,
    pub selected_install_method: InstallMethod,
    pub args_override: Vec<String>,
    pub env_override: HashMap<String, String>,
    pub hidden: bool,
}

impl From<&InstalledAgent> for InstalledAgentView {
    fn from(a: &InstalledAgent) -> Self {
        Self {
            installations: a.installations.clone(),
            selected_install_method: a.selected_install_method,
            args_override: a.args_override.clone(),
            env_override: a.env_override.clone(),
            hidden: a.hidden,
        }
    }
}

fn terminal_channel_exposed(reg: &RegistryAgent) -> bool {
    // Claude Terminal remains available to the backend for historical chats,
    // but is no longer a selectable product surface. Future terminal-capable
    // agents can still opt into the existing UI contract.
    reg.terminal_launch.is_some() && reg.id != "claude-acp"
}

fn installed_view_for(reg: &RegistryAgent, agent: &InstalledAgent) -> InstalledAgentView {
    let mut view = InstalledAgentView::from(agent);
    if reg.terminal_launch.is_some() && !terminal_channel_exposed(reg) {
        view.installations
            .retain(|install| install.method != InstallMethod::External);
        if view.selected_install_method == InstallMethod::External
            && view
                .installations
                .iter()
                .any(|install| install.method == InstallMethod::Npx)
        {
            view.selected_install_method = InstallMethod::Npx;
        }
    }
    view
}

/// Concrete executable grove would invoke. Only populated when there's a
/// resolvable binary path (auto-detected External installs primarily).
#[derive(Debug, Serialize)]
pub struct BinaryView {
    pub command: String,
    pub path: Option<String>,
    pub version: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct MarketplaceResponse {
    pub agents: Vec<MarketplaceAgent>,
    pub registry_fetched_at: Option<String>,
    pub registry_stale: bool,
    /// Ordered curated id list. Frontend can render a "Recommended" hint
    /// section, though after the v2.6 changes curated agents are also
    /// auto-installed for fresh users so they normally appear in Installed.
    pub curated: Vec<String>,
}

// ─── GET /api/v1/agents/marketplace ──────────────────────────────────────────

pub async fn list_marketplace() -> Result<Json<MarketplaceResponse>, MarketplaceError> {
    // Registry: cache-first, sync-refresh on cold start so the first
    // marketplace open after a fresh install has data.
    let mut registry = agent_registry::get();
    // Cache-empty heuristic: every entry is a grove-injected synthetic
    // (Trae/TraeX/Hermes/Kiro/OpenClaw — see `inject_trae_and_traex_entries`).
    // None of these come from upstream, so seeing only them means we
    // haven't successfully fetched the CDN registry yet.
    let synthetic_ids: &[&str] = &[
        installed_agents::TRAE_ID,
        installed_agents::TRAEX_ID,
        "hermes",
        "kiro",
        "openclaw",
    ];
    if registry
        .agents
        .iter()
        .all(|a| synthetic_ids.contains(&a.id.as_str()))
    {
        // Only the synthetics are present → registry cache is empty. Try a
        // sync refresh; on failure we still return the synthetics-only
        // doc so the user can at least see the synthetics.
        if let Ok(doc) = agent_registry::refresh().await {
            registry = doc;
            agent_registry::inject_trae_and_traex_after_refresh(&mut registry);
        }
    }

    // Kick off the PATH binary scan in the background — does NOT block this
    // response. The scan upserts/removes External installations as PATH
    // contents change; deferring it means the Installed tab opens
    // instantly from the DB while the scan refreshes state for the next
    // call. Manual Marketplace "Refresh" awaits a fresh scan via
    // `refresh_registry`.
    {
        let reg_clone = registry.clone();
        tokio::task::spawn_blocking(move || {
            let _ = installed_agents::auto_scan_path_binaries(&reg_clone);
        });
    }

    // Curated seed runs at BOOT (see api::mod::create_router) so chats
    // and config that reference curated ids resolve before the user ever
    // opens Marketplace. Nothing to do here.

    let stale = agent_registry::is_stale();
    let fetched_at = agent_registry::load_meta()
        .ok()
        .flatten()
        .map(|m| m.fetched_at.to_rfc3339());

    let installed_list = installed_agents::list()
        .map_err(|e| MarketplaceError::internal(format!("installed_agents: {}", e)))?;
    let installed_by_id: HashMap<String, InstalledAgent> = installed_list
        .into_iter()
        .map(|a| (a.id.clone(), a))
        .collect();

    let mut agents: Vec<MarketplaceAgent> = registry
        .agents
        .iter()
        .map(|reg| build_marketplace_agent(reg, installed_by_id.get(&reg.id)))
        .collect();

    // Also surface installed_agents rows whose id isn't in the registry
    // (e.g. an older install that the upstream registry has since removed).
    // We render them with whatever data we can recover from the install
    // record so the user can still uninstall / patch / launch.
    let registry_ids: std::collections::HashSet<&str> =
        registry.agents.iter().map(|a| a.id.as_str()).collect();
    for (id, agent) in &installed_by_id {
        if !registry_ids.contains(id.as_str()) {
            agents.push(build_marketplace_agent_orphan(agent));
        }
    }

    agents.sort_by(|a, b| {
        a.name
            .to_lowercase()
            .cmp(&b.name.to_lowercase())
            .then_with(|| a.id.cmp(&b.id))
    });

    Ok(Json(MarketplaceResponse {
        agents,
        registry_fetched_at: fetched_at,
        registry_stale: stale,
        curated: crate::storage::curated_agents::onboarding_agent_ids_owned(),
    }))
}

/// POST /api/v1/agents/marketplace/refresh
pub async fn refresh_registry() -> Result<Json<MarketplaceResponse>, MarketplaceError> {
    agent_registry::refresh()
        .await
        .map_err(|e| MarketplaceError::internal(format!("registry refresh failed: {}", e)))?;
    // User asked for fresh data — invalidate the auto-scan TTL AND run
    // the scan synchronously so the response reflects current PATH state.
    let registry = agent_registry::get();
    let _ = tokio::task::spawn_blocking(move || {
        installed_agents::refresh_path_installations(&registry)
    })
    .await;
    list_marketplace().await
}

fn build_marketplace_agent(
    reg: &RegistryAgent,
    installed: Option<&InstalledAgent>,
) -> MarketplaceAgent {
    let install_state = compute_install_state(installed);
    let available_install_methods = available_methods_for(reg);
    let expose_terminal = terminal_channel_exposed(reg);
    let binary = if reg.terminal_launch.is_some() && !expose_terminal {
        None
    } else {
        resolve_binary_view(reg, installed)
    };
    MarketplaceAgent {
        id: reg.id.clone(),
        name: reg.name.clone(),
        description: reg.description.clone(),
        version: if reg.version.is_empty() {
            None
        } else {
            Some(reg.version.clone())
        },
        repository: reg.repository.clone(),
        website: reg.website.clone(),
        authors: reg.authors.clone(),
        license: reg.license.clone(),
        icon_url: reg.icon.clone(),
        available_install_methods,
        supports_terminal_launch: expose_terminal,
        install_state,
        installed: installed.map(|agent| installed_view_for(reg, agent)),
        binary,
    }
}

/// Build a MarketplaceAgent for an installed_agents row whose id isn't in
/// the (current) registry. Renders just enough data to power the Installed
/// tab card; install/uninstall via the marketplace endpoint still works.
fn build_marketplace_agent_orphan(agent: &InstalledAgent) -> MarketplaceAgent {
    let install_state = compute_install_state(Some(agent));
    let binary = agent.selected_installation().and_then(|i| {
        i.install_path.as_ref().map(|p| BinaryView {
            command: agent.id.clone(),
            path: Some(p.clone()),
            version: if i.version.is_empty() {
                None
            } else {
                Some(i.version.clone())
            },
        })
    });
    MarketplaceAgent {
        id: agent.id.clone(),
        name: agent.id.clone(),
        description: String::new(),
        version: agent
            .selected_installation()
            .map(|i| i.version.clone())
            .filter(|v| !v.is_empty()),
        repository: None,
        website: None,
        authors: Vec::new(),
        license: None,
        icon_url: None,
        available_install_methods: agent
            .installations
            .iter()
            .map(|i| i.method)
            .collect::<Vec<_>>(),
        supports_terminal_launch: false,
        install_state,
        installed: Some(InstalledAgentView::from(agent)),
        binary,
    }
}

fn available_methods_for(reg: &RegistryAgent) -> Vec<InstallMethod> {
    let mut methods = Vec::new();
    if reg.distribution.npx.is_some() {
        methods.push(InstallMethod::Npx);
    }
    if !reg.distribution.binary.is_empty() {
        let platform = crate::storage::agent_install::current_platform_key();
        if let Some(target) = reg.distribution.binary.get(platform) {
            // Synthetic Trae/TraeX entries carry an empty archive — they
            // aren't installable, so don't surface Binary as a choice for
            // them.
            if !target.archive.is_empty() {
                methods.push(InstallMethod::Binary);
            }
        }
    }
    if reg.distribution.uvx.is_some() {
        methods.push(InstallMethod::Uvx);
    }
    methods
}

/// Strict, three-line rule. NO auto-detect via PATH or runtime probing —
/// the `installed_agents` row is the entire story.
///
///   - row exists, status=Installed, method != External → grove-installed
///   - row exists, status=Installed, method == External → auto-detected (Trae/TraeX)
///   - row exists, status=Installing                    → installing
///   - row exists, status=Failed                        → install-failed
///   - no row                                            → not-installed
fn compute_install_state(installed: Option<&InstalledAgent>) -> &'static str {
    let Some(agent) = installed else {
        return "not-installed";
    };
    let Some(active) = agent.selected_installation() else {
        return "not-installed";
    };
    match active.status {
        InstallStatus::Installing => "installing",
        InstallStatus::Failed => "install-failed",
        InstallStatus::Installed => {
            if matches!(active.method, InstallMethod::External) {
                "auto-detected"
            } else {
                "grove-installed"
            }
        }
    }
}

/// Resolve a binary view for the active installation when applicable.
/// Returns None for npx/uvx installs (where the command is `npx` / `uvx`
/// and the actual binary lives in npm/uv caches we don't surface).
fn resolve_binary_view(
    _reg: &RegistryAgent,
    installed: Option<&InstalledAgent>,
) -> Option<BinaryView> {
    let agent = installed?;
    let active = agent.selected_installation()?;
    match active.method {
        InstallMethod::Binary | InstallMethod::External => {
            let path = active.install_path.clone();
            let command = path
                .as_deref()
                .and_then(|p| std::path::Path::new(p).file_name())
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_else(|| agent.id.clone());
            Some(BinaryView {
                command,
                path,
                version: if active.version.is_empty() {
                    None
                } else {
                    Some(active.version.clone())
                },
            })
        }
        InstallMethod::Npx | InstallMethod::Uvx => None,
    }
}

// ─── Install / Uninstall / Patch ─────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct InstallRequest {
    pub method: InstallMethod,
}

#[derive(Debug, Serialize)]
pub struct InstallResponse {
    pub agent: InstalledAgentView,
}

/// POST /api/v1/agents/marketplace/{id}/install
///
/// Adds a single install channel to the agent's installations array. If the
/// agent has no row yet, creates one; otherwise upserts the channel,
/// replacing any existing entry of the same method (re-install / upgrade).
pub async fn install_agent(
    Path(id): Path<String>,
    Json(body): Json<InstallRequest>,
) -> Result<Json<InstallResponse>, MarketplaceError> {
    // Defense-in-depth: canonicalize before any lookup so a stale
    // frontend cache carrying a legacy id (e.g. `claude` vs `claude-acp`)
    // doesn't 404 a real installable agent.
    let id = installed_agents::canonicalize_agent_id(&id);
    let registry = agent_registry::get();
    let reg = registry
        .agents
        .iter()
        .find(|a| a.id == id)
        .ok_or_else(|| MarketplaceError::NotFound(format!("agent {} not in registry", id)))?
        .clone();

    // No PATH short-circuit here — External installations are managed by
    // the auto-scan (`installed_agents::auto_scan_path_binaries`) which
    // runs every list_marketplace and registers them automatically. The
    // explicit Install click is reserved for the channel the user picked.
    // If both an External row (from scan) and a user-installed channel
    // exist, the user picks which one is active via
    // `selected_install_method`.

    match body.method {
        InstallMethod::Npx => install_npx(&reg).await,
        InstallMethod::Binary => install_binary(&reg).await,
        InstallMethod::Uvx => install_uvx(&reg).await,
        InstallMethod::External => Err(MarketplaceError::BadRequest(
            "External installs are created automatically when grove detects the agent's CLI \
             on your PATH; there's no Install button to click. Remove the binary from PATH \
             to deregister."
                .to_string(),
        )),
    }
}

async fn install_npx(reg: &RegistryAgent) -> Result<Json<InstallResponse>, MarketplaceError> {
    if reg.distribution.npx.is_none() {
        return Err(MarketplaceError::BadRequest(format!(
            "agent {} has no npx distribution",
            reg.id
        )));
    }
    if !crate::check::command_exists("npx") {
        return Err(MarketplaceError::BadRequest(
            "`npx` not found on PATH — install Node.js to use npx-distributed agents".to_string(),
        ));
    }
    let install = Installation {
        method: InstallMethod::Npx,
        version: reg.version.clone(),
        install_path: None,
        status: InstallStatus::Installed,
        failure_reason: None,
        installed_at: chrono::Utc::now(),
    };
    let agent = installed_agents::add_installation(&reg.id, install)
        .map_err(|e| MarketplaceError::internal(format!("add installation: {}", e)))?;
    Ok(Json(InstallResponse {
        agent: InstalledAgentView::from(&agent),
    }))
}

async fn install_uvx(reg: &RegistryAgent) -> Result<Json<InstallResponse>, MarketplaceError> {
    if reg.distribution.uvx.is_none() {
        return Err(MarketplaceError::BadRequest(format!(
            "agent {} has no uvx distribution",
            reg.id
        )));
    }
    if !crate::check::command_exists("uvx") {
        return Err(MarketplaceError::BadRequest(
            "`uvx` not found on PATH — install astral-sh/uv to use uvx-distributed agents"
                .to_string(),
        ));
    }
    let install = Installation {
        method: InstallMethod::Uvx,
        version: reg.version.clone(),
        install_path: None,
        status: InstallStatus::Installed,
        failure_reason: None,
        installed_at: chrono::Utc::now(),
    };
    let agent = installed_agents::add_installation(&reg.id, install)
        .map_err(|e| MarketplaceError::internal(format!("add installation: {}", e)))?;
    Ok(Json(InstallResponse {
        agent: InstalledAgentView::from(&agent),
    }))
}

async fn install_binary(reg: &RegistryAgent) -> Result<Json<InstallResponse>, MarketplaceError> {
    let platform = crate::storage::agent_install::current_platform_key();
    let target = reg
        .distribution
        .binary
        .get(platform)
        .cloned()
        .ok_or_else(|| {
            MarketplaceError::BadRequest(format!(
                "{} has no binary build for platform {}",
                reg.id, platform
            ))
        })?;

    if target.archive.is_empty() {
        // Synthetic Trae/TraeX have empty archive — they aren't installable
        // through grove's installer. Reject early so we don't write a
        // poisoned `installing` row.
        return Err(MarketplaceError::BadRequest(format!(
            "{} is PATH-detected only and can't be installed via the marketplace",
            reg.id
        )));
    }

    // Mark installing up front so the UI can render a spinner.
    let installing = Installation {
        method: InstallMethod::Binary,
        version: reg.version.clone(),
        install_path: None,
        status: InstallStatus::Installing,
        failure_reason: None,
        installed_at: chrono::Utc::now(),
    };
    installed_agents::add_installation(&reg.id, installing)
        .map_err(|e| MarketplaceError::internal(format!("upsert installing-state: {}", e)))?;

    match crate::storage::agent_install::download_and_extract(&reg.id, &reg.version, &target).await
    {
        Ok(install_path) => {
            // Resolve the actual binary path inside the extracted dir,
            // validating containment against the install root so a
            // malicious registry can't escape with `..` segments.
            let cmd_rel = target.cmd.trim_start_matches("./");
            let bin_path = match crate::storage::agent_install::sanitize_extract_path(
                &install_path,
                std::path::Path::new(cmd_rel),
            ) {
                Ok(p) => p,
                Err(e) => {
                    let _ = std::fs::remove_dir_all(&install_path);
                    let _ = installed_agents::set_installation_status(
                        &reg.id,
                        InstallMethod::Binary,
                        InstallStatus::Failed,
                        Some(format!("invalid cmd path: {}", e)),
                    );
                    return Err(MarketplaceError::BadRequest(format!(
                        "registry entry rejected: cmd path escapes install dir ({:?})",
                        target.cmd
                    )));
                }
            };
            let installed = Installation {
                method: InstallMethod::Binary,
                version: reg.version.clone(),
                install_path: Some(bin_path.to_string_lossy().into_owned()),
                status: InstallStatus::Installed,
                failure_reason: None,
                installed_at: chrono::Utc::now(),
            };
            let agent = installed_agents::add_installation(&reg.id, installed)
                .map_err(|e| MarketplaceError::internal(format!("upsert installed: {}", e)))?;
            Ok(Json(InstallResponse {
                agent: InstalledAgentView::from(&agent),
            }))
        }
        Err(e) => {
            let _ = installed_agents::set_installation_status(
                &reg.id,
                InstallMethod::Binary,
                InstallStatus::Failed,
                Some(e.to_string()),
            );
            Err(MarketplaceError::internal(format!(
                "binary install failed: {}",
                e
            )))
        }
    }
}

#[derive(Debug, Deserialize)]
pub struct UninstallQuery {
    /// REQUIRED — uninstalls a single channel. If no channels remain on the
    /// agent, the whole row is dropped.
    pub method: InstallMethod,
}

/// DELETE /api/v1/agents/marketplace/{id}/install?method=<method>
pub async fn uninstall_agent(
    Path(id): Path<String>,
    Query(q): Query<UninstallQuery>,
) -> Result<StatusCode, MarketplaceError> {
    let id = installed_agents::canonicalize_agent_id(&id);
    let existing = installed_agents::get(&id)
        .map_err(|e| MarketplaceError::internal(format!("installed_agents: {}", e)))?;
    let Some(existing) = existing else {
        return Err(MarketplaceError::NotFound(format!("{} not installed", id)));
    };

    // External channels are auto-managed — the user deregisters by removing
    // the binary from PATH, not by clicking an uninstall button (no button
    // is rendered on the frontend). Reject if it leaks through anyway.
    if matches!(q.method, InstallMethod::External) {
        return Err(MarketplaceError::BadRequest(
            "External (auto-detected) installs are managed by PATH presence — \
             remove the binary from your PATH to deregister."
                .to_string(),
        ));
    }

    // Binary uninstall: cleanup the extracted dir IF the channel being
    // removed is Binary. Containment check: only paths under
    // `~/.grove/agents/` are eligible — defends against tampered
    // install_path values.
    if matches!(q.method, InstallMethod::Binary) {
        let install_root = crate::storage::agent_install::install_dir(
            &existing.id,
            &registry_version_or_empty(&existing),
        );
        let agents_root = crate::storage::grove_dir().join("agents");
        if install_root.exists() {
            match (install_root.canonicalize(), agents_root.canonicalize()) {
                (Ok(install_canon), Ok(agents_canon))
                    if install_canon.starts_with(&agents_canon) =>
                {
                    let _ = std::fs::remove_dir_all(&install_canon);
                }
                _ => {
                    eprintln!(
                        "[marketplace] refusing to remove install_root outside ~/.grove/agents/: {:?}",
                        install_root
                    );
                }
            }
        }
    }

    installed_agents::remove_installation(&id, q.method)
        .map_err(|e| MarketplaceError::internal(format!("remove installation: {}", e)))?;
    Ok(StatusCode::NO_CONTENT)
}

fn registry_version_or_empty(agent: &InstalledAgent) -> String {
    agent
        .installations
        .iter()
        .find(|i| i.method == InstallMethod::Binary)
        .map(|i| i.version.clone())
        .unwrap_or_default()
}

#[derive(Debug, Deserialize)]
pub struct PatchRequest {
    #[serde(default)]
    pub selected_install_method: Option<InstallMethod>,
    #[serde(default)]
    pub args_override: Option<Vec<String>>,
    #[serde(default)]
    pub env_override: Option<HashMap<String, String>>,
    #[serde(default)]
    pub hidden: Option<bool>,
}

/// PATCH /api/v1/agents/marketplace/{id}
pub async fn patch_agent(
    Path(id): Path<String>,
    Json(body): Json<PatchRequest>,
) -> Result<Json<InstalledAgentView>, MarketplaceError> {
    let id = installed_agents::canonicalize_agent_id(&id);
    let updated = installed_agents::patch_or_create(
        &id,
        body.selected_install_method,
        body.args_override,
        body.env_override,
        body.hidden,
    )
    .map_err(|e| match e {
        // Reject an install-method switch when the target channel isn't
        // installed → 400 (caller's fault) rather than 500.
        crate::error::GroveError::StorageTagged {
            tag: "channel_not_installed",
            msg,
        } => MarketplaceError::BadRequest(msg),
        other => MarketplaceError::internal(format!("patch: {}", other)),
    })?;
    Ok(Json(InstalledAgentView::from(&updated)))
}

// ─── Error type ──────────────────────────────────────────────────────────────

pub enum MarketplaceError {
    NotFound(String),
    BadRequest(String),
    Internal(String),
}

impl MarketplaceError {
    fn internal(msg: impl Into<String>) -> Self {
        MarketplaceError::Internal(msg.into())
    }
}

impl IntoResponse for MarketplaceError {
    fn into_response(self) -> axum::response::Response {
        match self {
            MarketplaceError::NotFound(msg) => (StatusCode::NOT_FOUND, msg).into_response(),
            MarketplaceError::BadRequest(msg) => (StatusCode::BAD_REQUEST, msg).into_response(),
            MarketplaceError::Internal(msg) => {
                (StatusCode::INTERNAL_SERVER_ERROR, msg).into_response()
            }
        }
    }
}

// Re-export distribution types under the `distribution` umbrella so older
// imports continue to work after this rewrite. The frontend doesn't see
// `Distribution` directly — it only sees `available_install_methods`.
#[allow(dead_code)]
pub(crate) fn _types_unused(_n: &NpxDistribution, _u: &UvxDistribution, _b: &BinaryTarget) {}

// Helper for the test in `agent_registry.rs` to add synthetics after a
// successful refresh — used by `list_marketplace`'s cold-start branch
// above. Re-injects after the document was wholesale replaced by refresh.
// (Implemented in agent_registry.rs.)
#[allow(unused_imports)]
use agent_registry as _agent_registry_alias;

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Utc;

    fn claude_registry_agent() -> RegistryAgent {
        RegistryAgent {
            id: "claude-acp".into(),
            name: "Claude".into(),
            version: "1.0.0".into(),
            description: String::new(),
            repository: None,
            website: None,
            authors: vec![],
            license: None,
            icon: None,
            distribution: crate::storage::agent_registry::Distribution {
                npx: Some(NpxDistribution {
                    package: "@example/claude-acp@1.0.0".into(),
                    args: vec![],
                    env: HashMap::new(),
                }),
                ..Default::default()
            },
            terminal_launch: Some(crate::storage::agent_registry::TerminalLaunch {
                cmd: "claude".into(),
                session_id_arg: "--session-id".into(),
                resume_arg: "--resume".into(),
                mcp_config_arg: "--mcp-config".into(),
            }),
        }
    }

    fn npx_install(version: &str) -> Installation {
        Installation {
            method: InstallMethod::Npx,
            version: version.into(),
            install_path: None,
            status: InstallStatus::Installed,
            failure_reason: None,
            installed_at: Utc::now(),
        }
    }

    fn external_install(path: &str) -> Installation {
        Installation {
            method: InstallMethod::External,
            version: "1.0.0".into(),
            install_path: Some(path.into()),
            status: InstallStatus::Installed,
            failure_reason: None,
            installed_at: Utc::now(),
        }
    }

    fn agent_with(installs: Vec<Installation>, selected: InstallMethod) -> InstalledAgent {
        let now = Utc::now();
        InstalledAgent {
            id: "claude-acp".into(),
            installations: installs,
            selected_install_method: selected,
            args_override: vec![],
            env_override: HashMap::new(),
            hidden: false,
            created_at: now,
            updated_at: now,
        }
    }

    #[test]
    fn install_state_distinguishes_grove_installed_vs_auto_detected() {
        // Npx with status=Installed → grove-installed.
        let agent = agent_with(vec![npx_install("1.0.0")], InstallMethod::Npx);
        assert_eq!(compute_install_state(Some(&agent)), "grove-installed");

        // External with status=Installed → auto-detected (Trae path).
        let agent = agent_with(
            vec![external_install("/usr/local/bin/traecli")],
            InstallMethod::External,
        );
        assert_eq!(compute_install_state(Some(&agent)), "auto-detected");

        // No row → not-installed.
        assert_eq!(compute_install_state(None), "not-installed");
    }

    #[test]
    fn claude_terminal_channel_is_hidden_from_marketplace_view() {
        let agent = agent_with(
            vec![
                npx_install("1.0.0"),
                external_install("/usr/local/bin/claude"),
            ],
            InstallMethod::Npx,
        );
        let view = build_marketplace_agent(&claude_registry_agent(), Some(&agent));

        assert!(!view.supports_terminal_launch);
        assert!(view.binary.is_none());
        let installed = view.installed.unwrap();
        assert_eq!(installed.selected_install_method, InstallMethod::Npx);
        assert_eq!(installed.installations.len(), 1);
        assert_eq!(installed.installations[0].method, InstallMethod::Npx);
    }
}

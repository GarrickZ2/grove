//! Agent marketplace handler.
//!
//! Single unified view that merges three sources:
//!   - ACP registry (cached on disk, fetched from CDN)
//!   - grove builtin supplement (BUILTIN_SUPPLEMENTS)
//!   - local PATH probe results (auto-detect)
//!
//! Frontend consumes one shape (`MarketplaceAgent`) and decides what to show
//! where (AgentPicker, Marketplace Modal, per-agent config sheet, etc).
//!
//! P2+ will layer installed_agents (SQLite) on top — for now `installState`
//! is computed purely from probe + null for `installed_version`.

use axum::{extract::Path, http::StatusCode, response::IntoResponse, Json};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

use crate::storage::agent_registry::{
    self, BinaryTarget, NpxDistribution, RegistryAgent, UvxDistribution,
};
use crate::storage::agent_supplement::{SupplementEntry, TerminalProfile, BUILTIN_SUPPLEMENTS};
use crate::storage::installed_agents::{self, InstallMethod, InstallStatus, InstalledAgent};

#[cfg(test)]
use crate::storage::agent_supplement;

/// Unified agent record returned to the frontend.
#[derive(Debug, Serialize)]
pub struct MarketplaceAgent {
    /// Canonical id — registry id when registered, else supplement.canonical_id.
    pub id: String,
    /// Legacy ids that historic data may reference (claude → claude-acp).
    pub legacy_aliases: Vec<String>,
    pub name: String,
    pub description: String,
    /// Grove-local icon identifier (asset key) — preferred over registry icon
    /// when supplement defines one.
    pub icon_id: Option<String>,
    /// CDN icon URL from registry (fallback / detail-view).
    pub icon_url: Option<String>,
    pub version: Option<String>,
    pub repository: Option<String>,
    pub website: Option<String>,
    pub authors: Vec<String>,
    pub license: Option<String>,
    /// `registry` = listed in upstream registry. `supplement-only` = grove
    /// supplement only (not yet in the registry — `hermes` etc).
    pub source: &'static str,
    /// `null` when neither registry nor supplement gives an installable
    /// channel (supplement-only entries with no distribution).
    pub distribution: Option<DistributionView>,
    pub supported_launch_modes: Vec<String>,
    /// "auto-detected" | "grove-installed" | "not-installed".
    /// P1 only knows auto-detected (probe pass) vs not-installed (probe fail);
    /// "grove-installed" lights up once P2 wires installed_agents in.
    pub install_state: &'static str,
    /// Hint commands the frontend can show in detail view (which PATH
    /// commands grove probed and what they resolved to). Mirrors what
    /// SettingsPage's existing AgentPicker availability surfaced.
    pub probe: ProbeView,
    /// Terminal-mode spawn template. Present iff supported_launch_modes
    /// includes "terminal".
    pub terminal_profile: Option<TerminalProfileView>,
    /// Local install record (null when no grove-managed install — even if
    /// `install_state="auto-detected"` we leave this null because grove
    /// didn't put the binary there).
    pub installed: Option<InstalledAgentView>,
    /// Effective launch mode for chats created against this agent. Reads
    /// from `Config.agent_launch_modes[id]`; defaults to "acp". Decoupled
    /// from install state so auto-detected agents can still be toggled.
    pub launch_mode: String,
}

/// Subset of `InstalledAgent` we expose to the frontend. Drops the raw
/// `installed_at` precision and the `install_path` (security: never leak
/// absolute filesystem paths in a list endpoint — Per-Agent Config Sheet
/// can fetch it separately if needed).
#[derive(Debug, Serialize)]
pub struct InstalledAgentView {
    pub version: String,
    pub install_method: InstallMethod,
    pub status: InstallStatus,
    pub failure_reason: Option<String>,
    pub args_override: Vec<String>,
    pub env_override: HashMap<String, String>,
    pub launch_mode: String,
    pub hidden: bool,
}

impl From<&InstalledAgent> for InstalledAgentView {
    fn from(a: &InstalledAgent) -> Self {
        Self {
            version: a.version.clone(),
            install_method: a.install_method,
            status: a.status,
            failure_reason: a.failure_reason.clone(),
            args_override: a.args_override.clone(),
            env_override: a.env_override.clone(),
            launch_mode: a.launch_mode.clone(),
            hidden: a.hidden,
        }
    }
}

#[derive(Debug, Serialize)]
pub struct DistributionView {
    pub npx: Option<NpxDistribution>,
    pub uvx: Option<UvxDistribution>,
    pub binary: HashMap<String, BinaryTarget>,
}

#[derive(Debug, Serialize)]
pub struct ProbeView {
    pub terminal_check: Option<String>,
    pub acp_check: Option<String>,
    pub acp_fallback: Option<String>,
    pub npx_package: Option<String>,
    /// Results for each probed command (true = on PATH).
    pub results: HashMap<String, bool>,
}

#[derive(Debug, Serialize)]
pub struct TerminalProfileView {
    pub base_command: String,
    pub fresh_args: Vec<String>,
    pub resume_args: Vec<String>,
    pub resume_check_pattern: String,
}

#[derive(Debug, Serialize)]
pub struct MarketplaceResponse {
    pub agents: Vec<MarketplaceAgent>,
    pub registry_fetched_at: Option<String>,
    pub registry_stale: bool,
}

/// GET /api/v1/agents/marketplace
pub async fn list_marketplace() -> Result<Json<MarketplaceResponse>, MarketplaceError> {
    // Cache-first read. If the cache is completely empty (first-ever
    // launch, or the startup background refresh hasn't landed yet) we
    // attempt one synchronous refresh so the marketplace modal opens with
    // real data instead of just the 13 supplement entries. Failures are
    // tolerated — the supplement-only view is still useful and the
    // `registry_fetched_at=null` field tells the UI to show a warning.
    let mut registry = agent_registry::get();
    if registry.agents.is_empty() {
        if let Ok(doc) = agent_registry::refresh().await {
            registry = doc;
        }
    }
    let stale = agent_registry::is_stale();
    let fetched_at = agent_registry::load_meta()
        .ok()
        .flatten()
        .map(|m| m.fetched_at.to_rfc3339());

    // Index registry by id for O(1) merge lookup.
    let mut registry_by_id: HashMap<String, RegistryAgent> = registry
        .agents
        .into_iter()
        .map(|a| (a.id.clone(), a))
        .collect();

    // Snapshot installed agents — we look up by canonical id when merging.
    let installed_list = installed_agents::list()
        .map_err(|e| MarketplaceError::internal(format!("installed_agents: {}", e)))?;
    let installed_by_id: HashMap<String, InstalledAgent> = installed_list
        .into_iter()
        .map(|a| (a.id.clone(), a))
        .collect();

    // launch_mode lives on the installed_agents row now — auto-detected
    // agents get an `install_method=External` stub the first time the user
    // edits a setting (see patch_or_create). Agents the user has never
    // touched don't appear in the table and fall through to "acp".
    let mut agents: Vec<MarketplaceAgent> = Vec::new();

    // Pass 1: walk supplement, merge with registry where matched.
    for supp in BUILTIN_SUPPLEMENTS {
        let registry_entry = registry_by_id.remove(supp.canonical_id);
        let installed = installed_by_id.get(supp.canonical_id);
        let mode = installed
            .map(|r| r.launch_mode.clone())
            .unwrap_or_else(|| "acp".to_string());
        agents.push(merge(supp, registry_entry, installed, mode));
    }

    // Pass 2: registry entries with no supplement match — surface them
    // verbatim with conservative defaults (ACP-only, no aliases).
    for (_, reg) in registry_by_id.into_iter() {
        let installed = installed_by_id.get(&reg.id);
        let mode = installed
            .map(|r| r.launch_mode.clone())
            .unwrap_or_else(|| "acp".to_string());
        agents.push(registry_only(reg, installed, mode));
    }

    // Stable order: alphabetical by name, then id. Anything supplement-driven
    // tends to bubble to a similar place across reloads, which keeps the UI
    // settled without us having to maintain a manual order.
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
    }))
}

/// POST /api/v1/agents/marketplace/refresh
pub async fn refresh_registry() -> Result<Json<MarketplaceResponse>, MarketplaceError> {
    // Manual refresh — surface failures verbatim so the UI can show why the
    // user is still looking at stale data. Auto-refresh (startup background
    // task + list endpoint's first-time fallback) tolerates failures
    // silently; this endpoint is user-initiated so they deserve an answer.
    agent_registry::refresh()
        .await
        .map_err(|e| MarketplaceError::internal(format!("registry refresh failed: {}", e)))?;
    list_marketplace().await
}

fn merge(
    supp: &SupplementEntry,
    registry: Option<RegistryAgent>,
    installed: Option<&InstalledAgent>,
    launch_mode: String,
) -> MarketplaceAgent {
    let (
        source,
        name,
        description,
        version,
        repository,
        website,
        authors,
        license,
        icon_url,
        distribution,
    ) = if let Some(reg) = registry {
        (
            "registry",
            supp.display_name.unwrap_or(&reg.name).to_string(),
            reg.description.clone(),
            Some(reg.version.clone()),
            reg.repository.clone(),
            reg.website.clone(),
            reg.authors.clone(),
            reg.license.clone(),
            reg.icon.clone(),
            Some(distribution_view(&reg)),
        )
    } else {
        (
            "supplement-only",
            supp.display_name.unwrap_or(supp.canonical_id).to_string(),
            String::new(),
            None,
            None,
            None,
            Vec::new(),
            None,
            None,
            None,
        )
    };

    let probe = probe_commands(supp);
    let install_state = compute_install_state(&probe.results, supp, installed);

    MarketplaceAgent {
        id: supp.canonical_id.to_string(),
        legacy_aliases: supp.legacy_aliases.iter().map(|s| s.to_string()).collect(),
        name,
        description,
        icon_id: Some(supp.icon_id.to_string()),
        icon_url,
        version,
        repository,
        website,
        authors,
        license,
        source,
        distribution,
        supported_launch_modes: supp
            .supported_launch_modes
            .iter()
            .map(|s| s.to_string())
            .collect(),
        install_state,
        probe,
        terminal_profile: supp.terminal_profile.as_ref().map(terminal_profile_view),
        installed: installed.map(InstalledAgentView::from),
        launch_mode,
    }
}

fn registry_only(
    reg: RegistryAgent,
    installed: Option<&InstalledAgent>,
    launch_mode: String,
) -> MarketplaceAgent {
    let install_state = match installed {
        Some(a) if a.status == InstallStatus::Installed && !a.hidden => "grove-installed",
        _ => "not-installed",
    };
    MarketplaceAgent {
        id: reg.id.clone(),
        legacy_aliases: Vec::new(),
        name: reg.name.clone(),
        description: reg.description.clone(),
        icon_id: None,
        icon_url: reg.icon.clone(),
        version: Some(reg.version.clone()),
        repository: reg.repository.clone(),
        website: reg.website.clone(),
        authors: reg.authors.clone(),
        license: reg.license.clone(),
        source: "registry",
        distribution: Some(distribution_view(&reg)),
        supported_launch_modes: vec!["acp".to_string()],
        install_state,
        probe: ProbeView {
            terminal_check: None,
            acp_check: None,
            acp_fallback: None,
            npx_package: None,
            results: HashMap::new(),
        },
        terminal_profile: None,
        installed: installed.map(InstalledAgentView::from),
        launch_mode,
    }
}

fn distribution_view(reg: &RegistryAgent) -> DistributionView {
    DistributionView {
        npx: reg.distribution.npx.clone(),
        uvx: reg.distribution.uvx.clone(),
        binary: reg.distribution.binary.clone(),
    }
}

fn terminal_profile_view(p: &TerminalProfile) -> TerminalProfileView {
    TerminalProfileView {
        base_command: p.base_command.to_string(),
        fresh_args: p.fresh_args.iter().map(|s| s.to_string()).collect(),
        resume_args: p.resume_args.iter().map(|s| s.to_string()).collect(),
        resume_check_pattern: p.resume_check_pattern.to_string(),
    }
}

/// Probe each PATH command supplement declared. We only run `which`-style
/// checks here, never spawn anything heavy. Empty map for entries with no
/// probe spec.
fn probe_commands(supp: &SupplementEntry) -> ProbeView {
    let mut results: HashMap<String, bool> = HashMap::new();
    for cmd in [supp.terminal_check, supp.acp_check, supp.acp_fallback]
        .into_iter()
        .flatten()
    {
        // Some probe commands (e.g. "hermes acp") encode a subcommand. We
        // only test the head — that's also what the existing
        // env::check_commands logic implicitly relies on (it never sees
        // multi-word commands today). Splitting here keeps the behavior
        // identical even if supplement adds a multi-word probe later.
        let head = cmd.split_whitespace().next().unwrap_or(cmd);
        if !results.contains_key(head) {
            results.insert(head.to_string(), crate::check::command_exists(head));
        }
    }
    if supp.npx_package.is_some() && !results.contains_key("npx") {
        results.insert("npx".to_string(), crate::check::command_exists("npx"));
    }
    ProbeView {
        terminal_check: supp.terminal_check.map(|s| s.to_string()),
        acp_check: supp.acp_check.map(|s| s.to_string()),
        acp_fallback: supp.acp_fallback.map(|s| s.to_string()),
        npx_package: supp.npx_package.map(|s| s.to_string()),
        results,
    }
}

// Mirrors the frontend's existing applyAcpAvailability rule:
//   - terminal_check on PATH AND
//   - (acp_check OR acp_fallback on PATH) OR (npx is available and supplement
//     declared an npx package)
// → installed (auto-detected). Else not-installed.
//
// "grove-installed" path lights up in P2 when SQLite installed_agents
// records this id.
fn head_word(cmd: Option<&str>) -> Option<&str> {
    cmd.and_then(|c| c.split_whitespace().next())
}

fn compute_install_state(
    results: &HashMap<String, bool>,
    supp: &SupplementEntry,
    installed: Option<&InstalledAgent>,
) -> &'static str {
    // Grove-managed install wins when present + healthy + not hidden — the
    // user explicitly opted into this so we surface it ahead of probe.
    //
    // `External` rows are NOT a grove-managed install — they're stub rows
    // created by `patch_or_create` when a user edits launch_mode/args/env
    // on an auto-detected agent. The row exists only to store preferences;
    // the actual binary is still on the user's PATH. We fall through to the
    // probe path below so the install_state reflects what's reachable.
    if let Some(a) = installed {
        let is_grove_managed = !matches!(a.install_method, InstallMethod::External);
        if is_grove_managed {
            if a.status == InstallStatus::Installed && !a.hidden {
                return "grove-installed";
            }
            if a.status == InstallStatus::Installing {
                return "installing";
            }
            if a.status == InstallStatus::Failed {
                return "install-failed";
            }
        }
    }

    let term_ok = match head_word(supp.terminal_check) {
        Some(c) => *results.get(c).unwrap_or(&false),
        None => true, // no terminal_check spec = don't gate on it
    };
    let acp_primary = head_word(supp.acp_check)
        .map(|c| *results.get(c).unwrap_or(&false))
        .unwrap_or(false);
    let acp_fallback = head_word(supp.acp_fallback)
        .map(|c| *results.get(c).unwrap_or(&false))
        .unwrap_or(false);
    let npx_ok = supp.npx_package.is_some() && *results.get("npx").unwrap_or(&false);

    if term_ok && (acp_primary || acp_fallback || npx_ok) {
        "auto-detected"
    } else {
        "not-installed"
    }
}

pub enum MarketplaceError {
    NotFound(String),
    BadRequest(String),
    Internal(String),
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

impl MarketplaceError {
    fn internal(msg: impl Into<String>) -> Self {
        MarketplaceError::Internal(msg.into())
    }
}

// ─── Install / Uninstall / Patch ─────────────────────────────────────────────

/// Body for POST /agents/marketplace/{id}/install. `method` lets the user
/// override which distribution path to use when multiple are available
/// (e.g. registry agent offering both npx and binary). Defaults to the
/// preferred order: npx > binary > uvx (chosen for least system disruption
/// and ubiquity of node).
#[derive(Debug, Deserialize, Default)]
pub struct InstallRequest {
    #[serde(default)]
    pub method: Option<InstallMethod>,
}

#[derive(Debug, Serialize)]
pub struct InstallResponse {
    pub agent: InstalledAgentView,
}

/// POST /api/v1/agents/marketplace/{id}/install
pub async fn install_agent(
    Path(id): Path<String>,
    Json(body): Json<InstallRequest>,
) -> Result<Json<InstallResponse>, MarketplaceError> {
    let registry = agent_registry::get();
    let reg = registry
        .agents
        .iter()
        .find(|a| a.id == id)
        .ok_or_else(|| MarketplaceError::NotFound(format!("agent {} not in registry cache", id)))?
        .clone();

    // Resolve method: explicit > npx > binary > uvx.
    let method = body.method.unwrap_or_else(|| pick_default_method(&reg));
    match method {
        InstallMethod::Npx => install_npx(&reg).await,
        InstallMethod::Binary => install_binary(&reg).await,
        InstallMethod::Uvx => install_uvx(&reg).await,
        InstallMethod::External => Err(MarketplaceError::BadRequest(
            "External isn't an install method — it's the marker for \
             auto-detected PATH binaries. Use npx/binary/uvx instead."
                .to_string(),
        )),
    }
}

fn pick_default_method(reg: &RegistryAgent) -> InstallMethod {
    if reg.distribution.npx.is_some() {
        InstallMethod::Npx
    } else if !reg.distribution.binary.is_empty() {
        InstallMethod::Binary
    } else if reg.distribution.uvx.is_some() {
        InstallMethod::Uvx
    } else {
        // Will surface as BadRequest downstream — registry without any usable
        // channel can't be installed via marketplace.
        InstallMethod::Npx
    }
}

/// binary install = pick the current-platform archive, download, extract under
/// `~/.grove/agents/<id>/<version>/`, record install_path. P5 launcher will
/// run `<install_path>/<target.cmd>` with `target.args` and `target.env`.
///
/// We mark `status="installing"` in the DB before starting the (potentially
/// slow) download so the marketplace endpoint's poll-based UI can show
/// progress. On any error we set status="failed" + failure_reason — the row
/// stays so the user can see what went wrong without re-installing.
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

    // Record installing-status up front so the picker can show a spinner.
    let now = chrono::Utc::now();
    let mut agent = InstalledAgent {
        id: reg.id.clone(),
        version: reg.version.clone(),
        install_method: InstallMethod::Binary,
        install_path: None,
        status: InstallStatus::Installing,
        failure_reason: None,
        args_override: Vec::new(),
        env_override: target.env.clone(),
        launch_mode: "acp".to_string(),
        hidden: false,
        installed_at: now,
        updated_at: now,
    };
    installed_agents::upsert(&agent)
        .map_err(|e| MarketplaceError::internal(format!("upsert installing-state: {}", e)))?;

    match crate::storage::agent_install::download_and_extract(&reg.id, &reg.version, &target).await
    {
        Ok(install_path) => {
            agent.status = InstallStatus::Installed;
            // Resolve the full binary path here so launchers don't need
            // to consult the registry at spawn time. `target.cmd` from the
            // registry is a relative path like `./amp-acp` — strip the
            // leading "./" and join to the extracted dir.
            let cmd_rel = target.cmd.trim_start_matches("./");
            let bin_path = install_path.join(cmd_rel);
            agent.install_path = Some(bin_path.to_string_lossy().into_owned());
            agent.updated_at = chrono::Utc::now();
            installed_agents::upsert(&agent).map_err(|e| {
                MarketplaceError::internal(format!("upsert installed-state: {}", e))
            })?;
            Ok(Json(InstallResponse {
                agent: InstalledAgentView::from(&agent),
            }))
        }
        Err(e) => {
            // Persist the failure so the user sees the reason next render.
            let _ =
                installed_agents::set_status(&reg.id, InstallStatus::Failed, Some(e.to_string()));
            Err(MarketplaceError::internal(format!(
                "binary install failed: {}",
                e
            )))
        }
    }
}

/// npx install = pin the exact version from registry + mark installed. The
/// actual download happens on first launch (npx is lazy by design). We don't
/// pre-warm because that's npm's job, and grove staying out of npm's cache
/// keeps uninstall clean (we never wrote to it).
async fn install_npx(reg: &RegistryAgent) -> Result<Json<InstallResponse>, MarketplaceError> {
    let npx = reg.distribution.npx.as_ref().ok_or_else(|| {
        MarketplaceError::BadRequest(format!("agent {} has no npx distribution", reg.id))
    })?;

    // Sanity-check that `npx` itself is on PATH — surface the failure now
    // rather than at first launch.
    if !crate::check::command_exists("npx") {
        return Err(MarketplaceError::BadRequest(
            "`npx` not found on PATH — install Node.js / npm to use npx-distributed agents"
                .to_string(),
        ));
    }

    let now = chrono::Utc::now();
    let agent = InstalledAgent {
        id: reg.id.clone(),
        version: reg.version.clone(),
        install_method: InstallMethod::Npx,
        install_path: None,
        status: InstallStatus::Installed,
        failure_reason: None,
        args_override: Vec::new(),
        env_override: npx.env.clone(),
        launch_mode: "acp".to_string(),
        hidden: false,
        installed_at: now,
        updated_at: now,
    };
    installed_agents::upsert(&agent)
        .map_err(|e| MarketplaceError::internal(format!("upsert installed_agents: {}", e)))?;
    Ok(Json(InstallResponse {
        agent: InstalledAgentView::from(&agent),
    }))
}

/// uvx install — uv's equivalent of npx. Same lazy-launch contract as npx
/// (mark + version-pin, runtime spawn `uvx <pkg>@<ver>`).
async fn install_uvx(reg: &RegistryAgent) -> Result<Json<InstallResponse>, MarketplaceError> {
    let uvx = reg.distribution.uvx.as_ref().ok_or_else(|| {
        MarketplaceError::BadRequest(format!("agent {} has no uvx distribution", reg.id))
    })?;

    if !crate::check::command_exists("uvx") {
        return Err(MarketplaceError::BadRequest(
            "`uvx` not found on PATH — install astral-sh/uv to use uvx-distributed agents"
                .to_string(),
        ));
    }

    let now = chrono::Utc::now();
    let agent = InstalledAgent {
        id: reg.id.clone(),
        version: reg.version.clone(),
        install_method: InstallMethod::Uvx,
        install_path: None,
        status: InstallStatus::Installed,
        failure_reason: None,
        args_override: Vec::new(),
        env_override: uvx.env.clone(),
        launch_mode: "acp".to_string(),
        hidden: false,
        installed_at: now,
        updated_at: now,
    };
    installed_agents::upsert(&agent)
        .map_err(|e| MarketplaceError::internal(format!("upsert installed_agents: {}", e)))?;
    Ok(Json(InstallResponse {
        agent: InstalledAgentView::from(&agent),
    }))
}

/// DELETE /api/v1/agents/marketplace/{id}/install
pub async fn uninstall_agent(Path(id): Path<String>) -> Result<StatusCode, MarketplaceError> {
    let existing = installed_agents::get(&id)
        .map_err(|e| MarketplaceError::internal(format!("installed_agents: {}", e)))?;
    let Some(existing) = existing else {
        return Err(MarketplaceError::NotFound(format!(
            "{} not installed by grove",
            id
        )));
    };

    // For binary installs, P3 will own filesystem cleanup. P2 npx has no
    // on-disk artifact owned by grove, so DB delete is the whole uninstall.
    if let Some(path) = &existing.install_path {
        // Defensive: only delete inside ~/.grove/agents/. Never act on a
        // user-supplied path even if the row somehow got one.
        let agents_root = crate::storage::grove_dir().join("agents");
        let p = std::path::Path::new(path);
        if p.starts_with(&agents_root) && p.exists() {
            let _ = std::fs::remove_dir_all(p);
        } else {
            eprintln!(
                "[marketplace] refusing to remove install_path outside ~/.grove/agents/: {:?}",
                path
            );
        }
    }

    installed_agents::delete(&id)
        .map_err(|e| MarketplaceError::internal(format!("delete installed_agents: {}", e)))?;
    Ok(StatusCode::NO_CONTENT)
}

/// PATCH /api/v1/agents/marketplace/{id}
#[derive(Debug, Deserialize)]
pub struct PatchRequest {
    #[serde(default)]
    pub args_override: Option<Vec<String>>,
    #[serde(default)]
    pub env_override: Option<HashMap<String, String>>,
    #[serde(default)]
    pub launch_mode: Option<String>,
    #[serde(default)]
    pub hidden: Option<bool>,
}

pub async fn patch_agent(
    Path(id): Path<String>,
    Json(body): Json<PatchRequest>,
) -> Result<Json<InstalledAgentView>, MarketplaceError> {
    if let Some(m) = body.launch_mode.as_deref() {
        if m != "acp" && m != "terminal" {
            return Err(MarketplaceError::BadRequest(format!(
                "launch_mode must be 'acp' or 'terminal' (got {:?})",
                m
            )));
        }
    }
    // installed_agents is the single source of truth for per-agent prefs
    // (launch_mode, args/env override, hidden). Auto-detected agents get
    // a minimal `install_method=External` stub upserted here on first
    // edit — keeps the table sparse but makes lookups uniform.
    let updated = installed_agents::patch_or_create(
        &id,
        body.args_override,
        body.env_override,
        body.launch_mode,
        body.hidden,
    )
    .map_err(|e| MarketplaceError::internal(format!("patch: {}", e)))?;
    Ok(Json(InstalledAgentView::from(&updated)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn supplement_only_entry_has_no_distribution() {
        let supp = agent_supplement::find_supplement("hermes").unwrap();
        let merged = merge(supp, None, None, "acp".to_string());
        assert_eq!(merged.source, "supplement-only");
        assert!(merged.distribution.is_none());
    }

    #[test]
    fn merge_prefers_supplement_display_name() {
        let supp = agent_supplement::find_supplement("claude-acp").unwrap();
        let reg = RegistryAgent {
            id: "claude-acp".into(),
            name: "Different Name From Registry".into(),
            version: "9.9.9".into(),
            description: "from-registry".into(),
            repository: None,
            website: None,
            authors: vec![],
            license: None,
            icon: None,
            distribution: Default::default(),
        };
        let merged = merge(supp, Some(reg), None, "acp".to_string());
        assert_eq!(merged.name, "Claude Code"); // supplement wins
        assert_eq!(merged.description, "from-registry"); // registry fills the gap
        assert_eq!(merged.version.as_deref(), Some("9.9.9"));
    }

    #[test]
    fn claude_carries_terminal_profile() {
        let supp = agent_supplement::find_supplement("claude-acp").unwrap();
        let merged = merge(supp, None, None, "acp".to_string());
        assert!(merged.terminal_profile.is_some());
        let tp = merged.terminal_profile.unwrap();
        assert_eq!(tp.base_command, "claude");
    }

    #[test]
    fn non_terminal_agent_has_no_profile() {
        let supp = agent_supplement::find_supplement("gemini").unwrap();
        let merged = merge(supp, None, None, "acp".to_string());
        assert!(merged.terminal_profile.is_none());
    }
}

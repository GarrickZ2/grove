//! Skills API handlers — agents, sources, explore, install/uninstall

use axum::{
    extract::{Path, Query},
    http::StatusCode,
    response::IntoResponse,
    Json,
};
use serde::{Deserialize, Serialize};

use crate::operations::skills as ops;
use crate::storage::skills::{
    self, compute_repo_key, load_installed, load_manifest, load_sources, parse_skill_md,
    save_sources, subpaths_overlap, AgentDef, InstalledSkillDef, SkillSourceDef,
};

// ============================================================================
// Response DTOs
// ============================================================================

#[derive(Debug, Serialize)]
pub struct AgentResponse {
    pub id: String,
    pub display_name: String,
    pub global_skills_dir: String,
    pub project_skills_dir: String,
    pub shared_group: Option<String>,
    pub icon_id: Option<String>,
    pub enabled: bool,
    pub is_builtin: bool,
}

impl From<&AgentDef> for AgentResponse {
    fn from(a: &AgentDef) -> Self {
        Self {
            id: a.id.clone(),
            display_name: a.display_name.clone(),
            global_skills_dir: a.global_skills_dir.clone(),
            project_skills_dir: a.project_skills_dir.clone(),
            shared_group: a.shared_group.clone(),
            icon_id: a.icon_id.clone(),
            enabled: a.enabled,
            is_builtin: a.is_builtin,
        }
    }
}

#[derive(Debug, Serialize)]
pub struct SourceResponse {
    pub name: String,
    pub source_type: String,
    pub url: String,
    pub subpath: Option<String>,
    pub repo_key: String,
    pub skill_count: usize,
    pub last_synced: Option<String>,
    pub has_remote_updates: bool,
}

#[derive(Debug, Serialize)]
pub struct SkillSummaryResponse {
    pub name: String,
    pub description: String,
    pub source: String,
    pub repo_key: String,
    pub relative_path: String,
    pub repo_path: String,
    pub install_status: String,
    pub installed_agent_count: usize,
    pub total_agents: usize,
    pub license: Option<String>,
    pub author: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct SkillDetailResponse {
    pub name: String,
    pub description: String,
    pub source: String,
    pub repo_key: String,
    pub relative_path: String,
    pub repo_path: String,
    pub skill_md_content: String,
    pub metadata: SkillMetadataResponse,
    pub install_status: String,
    pub installed_agents: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct SkillMetadataResponse {
    // Official fields
    pub name: String,
    pub description: String,
    pub license: Option<String>,
    pub compatibility: Option<String>,
    pub allowed_tools: Option<String>,
    /// Non-standard frontmatter + official `metadata:` block entries
    pub fields: std::collections::BTreeMap<String, String>,
}

#[derive(Debug, Serialize)]
pub struct InstalledSkillResponse {
    pub skill_name: String,
    pub repo_key: String,
    pub source_name: String,
    pub repo_path: String,
    pub agents: Vec<AgentInstallResponse>,
    pub installed_at: String,
}

#[derive(Debug, Serialize)]
pub struct AgentInstallResponse {
    pub agent_id: String,
    pub scope: String,
    pub symlink_path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_path: Option<String>,
}

#[derive(Debug, Serialize)]
struct ErrorResponse {
    error: String,
}

#[derive(Debug, Serialize)]
struct ConflictResponse {
    error: String,
    error_type: String,
    conflict_source_name: String,
    conflict_skill_name: String,
}

fn error_response(status: StatusCode, msg: &str) -> impl IntoResponse {
    (
        status,
        Json(ErrorResponse {
            error: msg.to_string(),
        }),
    )
}

// ============================================================================
// Request DTOs
// ============================================================================

#[derive(Debug, Deserialize)]
pub struct AddAgentRequest {
    pub display_name: String,
    pub global_skills_dir: String,
    pub project_skills_dir: String,
}

#[derive(Debug, Deserialize)]
pub struct AddSourceRequest {
    pub name: String,
    pub source_type: String,
    pub url: String,
    pub subpath: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct ExploreQuery {
    pub search: Option<String>,
    pub source: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct InstallSkillRequest {
    pub repo_key: String,
    pub source_name: String,
    pub skill_name: String,
    pub repo_path: String,
    pub relative_path: String,
    pub scope: String,
    pub agents: Vec<InstallAgentRequest>,
    pub project_path: Option<String>,
    pub force: Option<bool>,
}

#[derive(Debug, Deserialize)]
pub struct InstallAgentRequest {
    pub agent_id: String,
}

// ============================================================================
// Agent Handlers
// ============================================================================

/// GET /api/v1/skills/agents
pub async fn list_agents() -> impl IntoResponse {
    let agents: Vec<AgentResponse> = skills::get_all_agents()
        .iter()
        .map(AgentResponse::from)
        .collect();
    Json(agents)
}

/// POST /api/v1/skills/agents
pub async fn add_agent(Json(req): Json<AddAgentRequest>) -> impl IntoResponse {
    let id = req
        .display_name
        .to_lowercase()
        .chars()
        .map(|c| if c.is_alphanumeric() { c } else { '-' })
        .collect::<String>();

    // Check for duplicate against all agents (builtin + custom)
    if skills::get_all_agents().iter().any(|a| a.id == id) {
        return error_response(StatusCode::CONFLICT, "Agent with this ID already exists")
            .into_response();
    }

    let agent = AgentDef {
        id,
        display_name: req.display_name,
        global_skills_dir: req.global_skills_dir,
        project_skills_dir: req.project_skills_dir,
        shared_group: None,
        icon_id: None,
        enabled: true,
        is_builtin: false,
    };

    if let Err(e) = skills::add_custom_agent(agent.clone()) {
        return error_response(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()).into_response();
    }

    Json(AgentResponse::from(&agent)).into_response()
}

/// PUT /api/v1/skills/agents/{id}
pub async fn update_agent(
    Path(id): Path<String>,
    Json(req): Json<AddAgentRequest>,
) -> impl IntoResponse {
    if skills::is_builtin_agent(&id) {
        return error_response(StatusCode::FORBIDDEN, "Cannot edit builtin agent").into_response();
    }

    match skills::update_custom_agent(
        &id,
        req.display_name,
        req.global_skills_dir,
        req.project_skills_dir,
    ) {
        Ok(true) => {
            // Re-fetch updated agent for response
            if let Some(agent) = skills::get_all_agents().into_iter().find(|a| a.id == id) {
                Json(AgentResponse::from(&agent)).into_response()
            } else {
                error_response(StatusCode::NOT_FOUND, "Agent not found").into_response()
            }
        }
        Ok(false) => {
            error_response(StatusCode::NOT_FOUND, "Custom agent not found").into_response()
        }
        Err(e) => error_response(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()).into_response(),
    }
}

/// DELETE /api/v1/skills/agents/{id}
pub async fn delete_agent(Path(id): Path<String>) -> impl IntoResponse {
    if skills::is_builtin_agent(&id) {
        return error_response(StatusCode::FORBIDDEN, "Cannot delete builtin agent")
            .into_response();
    }

    match skills::delete_custom_agent(&id) {
        Ok(true) => StatusCode::NO_CONTENT.into_response(),
        Ok(false) => {
            error_response(StatusCode::NOT_FOUND, "Custom agent not found").into_response()
        }
        Err(e) => error_response(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()).into_response(),
    }
}

/// POST /api/v1/skills/agents/{id}/toggle
pub async fn toggle_agent(Path(id): Path<String>) -> impl IntoResponse {
    let all_agents = skills::get_all_agents();
    let agent = all_agents.iter().find(|a| a.id == id);
    let Some(agent) = agent else {
        return error_response(StatusCode::NOT_FOUND, "Agent not found").into_response();
    };

    let new_enabled = !agent.enabled;

    if agent.is_builtin {
        if let Err(e) = skills::set_builtin_enabled(&id, new_enabled) {
            return error_response(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string())
                .into_response();
        }
    } else {
        // For custom agents, toggle via update
        let mut file = skills::load_agents();
        if let Some(custom) = file.custom_agents.iter_mut().find(|a| a.id == id) {
            custom.enabled = new_enabled;
        }
        if let Err(e) = skills::save_agents(&file) {
            return error_response(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string())
                .into_response();
        }
    }

    // Return updated agent
    if let Some(updated) = skills::get_all_agents().into_iter().find(|a| a.id == id) {
        Json(AgentResponse::from(&updated)).into_response()
    } else {
        error_response(StatusCode::NOT_FOUND, "Agent not found after toggle").into_response()
    }
}

// ============================================================================
// Source Handlers
// ============================================================================

fn source_to_response(
    s: &SkillSourceDef,
    skill_count: usize,
    has_remote_updates: bool,
) -> SourceResponse {
    SourceResponse {
        name: s.name.clone(),
        source_type: s.source_type.clone(),
        url: s.url.clone(),
        subpath: s.subpath.clone(),
        repo_key: s.repo_key.clone(),
        skill_count,
        last_synced: s.last_synced.map(|dt| dt.to_rfc3339()),
        has_remote_updates,
    }
}

/// GET /api/v1/skills/sources
pub async fn list_sources() -> impl IntoResponse {
    let sources_file = load_sources();
    let manifest = load_manifest();

    let responses: Vec<SourceResponse> = sources_file
        .sources
        .iter()
        .map(|s| {
            let count = manifest
                .skills
                .iter()
                .filter(|sk| sk.source == s.name)
                .count();
            source_to_response(s, count, false)
        })
        .collect();

    Json(responses)
}

/// POST /api/v1/skills/sources
pub async fn add_source(Json(req): Json<AddSourceRequest>) -> impl IntoResponse {
    let mut sources_file = load_sources();

    if sources_file.sources.iter().any(|s| s.name == req.name) {
        return error_response(StatusCode::CONFLICT, "Source with this name already exists")
            .into_response();
    }

    let repo_key = compute_repo_key(&req.url);

    // Subpath overlap detection for git sources
    if req.source_type == "git" {
        for existing in &sources_file.sources {
            if existing.repo_key != repo_key {
                continue;
            }
            if subpaths_overlap(existing.subpath.as_deref(), req.subpath.as_deref()) {
                let msg = format!(
                    "Subpath conflicts with existing source '{}' (same repository, overlapping paths)",
                    existing.name
                );
                return error_response(StatusCode::CONFLICT, &msg).into_response();
            }
        }
    }

    let source = SkillSourceDef {
        name: req.name.clone(),
        source_type: req.source_type,
        url: req.url,
        subpath: req.subpath,
        repo_key,
        last_synced: None,
        local_head: None,
    };

    sources_file.sources.push(source);
    if let Err(e) = save_sources(&sources_file) {
        return error_response(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()).into_response();
    }

    // Trigger initial sync
    match ops::sync_source(&req.name) {
        Ok(updated) => {
            let manifest = load_manifest();
            let count = manifest
                .skills
                .iter()
                .filter(|sk| sk.source == req.name)
                .count();
            Json(source_to_response(&updated, count, false)).into_response()
        }
        Err(e) => {
            // Source was saved but sync failed — return it with error info
            let manifest = load_manifest();
            let sources_file = load_sources();
            if let Some(s) = sources_file.sources.iter().find(|s| s.name == req.name) {
                let count = manifest
                    .skills
                    .iter()
                    .filter(|sk| sk.source == req.name)
                    .count();
                // Return source but with a warning header
                let resp = source_to_response(s, count, false);
                (StatusCode::CREATED, Json(resp)).into_response()
            } else {
                error_response(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    &format!("Sync failed: {}", e),
                )
                .into_response()
            }
        }
    }
}

/// PUT /api/v1/skills/sources/{name}
pub async fn update_source(
    Path(name): Path<String>,
    Json(req): Json<AddSourceRequest>,
) -> impl IntoResponse {
    let mut sources_file = load_sources();

    let source = sources_file.sources.iter_mut().find(|s| s.name == name);
    let Some(source) = source else {
        return error_response(StatusCode::NOT_FOUND, "Source not found").into_response();
    };

    source.source_type = req.source_type.clone();
    source.url = req.url.clone();
    source.subpath = req.subpath;
    source.repo_key = compute_repo_key(&req.url);

    let resp_source = source.clone();
    if let Err(e) = save_sources(&sources_file) {
        return error_response(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()).into_response();
    }

    let manifest = load_manifest();
    let count = manifest
        .skills
        .iter()
        .filter(|sk| sk.source == name)
        .count();
    Json(source_to_response(&resp_source, count, false)).into_response()
}

/// DELETE /api/v1/skills/sources/{name}
pub async fn delete_source(Path(name): Path<String>) -> impl IntoResponse {
    match ops::delete_source(&name) {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(e) => error_response(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()).into_response(),
    }
}

/// POST /api/v1/skills/sources/{name}/sync
pub async fn sync_source(Path(name): Path<String>) -> impl IntoResponse {
    match ops::sync_source(&name) {
        Ok(updated) => {
            let manifest = load_manifest();
            let count = manifest
                .skills
                .iter()
                .filter(|sk| sk.source == name)
                .count();
            Json(source_to_response(&updated, count, false)).into_response()
        }
        Err(e) => error_response(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()).into_response(),
    }
}

/// POST /api/v1/skills/sources/sync-all
pub async fn sync_all_sources() -> impl IntoResponse {
    match ops::sync_all_sources() {
        Ok(sources) => {
            let manifest = load_manifest();
            let responses: Vec<SourceResponse> = sources
                .iter()
                .map(|s| {
                    let count = manifest
                        .skills
                        .iter()
                        .filter(|sk| sk.source == s.name)
                        .count();
                    source_to_response(s, count, false)
                })
                .collect();
            Json(responses).into_response()
        }
        Err(e) => error_response(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()).into_response(),
    }
}

/// POST /api/v1/skills/sources/check-updates
pub async fn check_updates() -> impl IntoResponse {
    match ops::check_source_updates() {
        Ok(update_infos) => {
            let sources_file = load_sources();
            let manifest = load_manifest();
            let responses: Vec<SourceResponse> = sources_file
                .sources
                .iter()
                .map(|s| {
                    let count = manifest
                        .skills
                        .iter()
                        .filter(|sk| sk.source == s.name)
                        .count();
                    let has_updates = update_infos
                        .iter()
                        .find(|u| u.name == s.name)
                        .map(|u| u.has_remote_updates)
                        .unwrap_or(false);
                    source_to_response(s, count, has_updates)
                })
                .collect();
            Json(responses).into_response()
        }
        Err(e) => error_response(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()).into_response(),
    }
}

// ============================================================================
// Installed record → flat API response
// ============================================================================

fn installed_to_response(i: &InstalledSkillDef) -> InstalledSkillResponse {
    let mut agents = Vec::new();
    for a in &i.global_agents {
        agents.push(AgentInstallResponse {
            agent_id: a.agent_id.clone(),
            scope: "global".to_string(),
            symlink_path: a.symlink_path.clone().unwrap_or_default(),
            project_path: None,
        });
    }
    for pi in &i.project_installs {
        for a in &pi.agents {
            agents.push(AgentInstallResponse {
                agent_id: a.agent_id.clone(),
                scope: "project".to_string(),
                symlink_path: a.symlink_path.clone().unwrap_or_default(),
                project_path: Some(pi.project_path.clone()),
            });
        }
    }
    InstalledSkillResponse {
        skill_name: i.skill_name.clone(),
        repo_key: i.repo_key.clone(),
        source_name: i.source_name.clone(),
        repo_path: i.repo_path.clone(),
        agents,
        installed_at: i.installed_at.to_rfc3339(),
    }
}

// ============================================================================
// Skill Handlers
// ============================================================================

/// GET /api/v1/skills/explore
pub async fn explore_skills(Query(query): Query<ExploreQuery>) -> impl IntoResponse {
    let manifest = load_manifest();
    let installed_file = load_installed();
    let all_agents = skills::get_all_agents();
    let total_agents = all_agents.iter().filter(|a| a.enabled).count();

    let mut skills: Vec<SkillSummaryResponse> = manifest
        .skills
        .iter()
        .filter(|s| {
            // Filter by source
            if let Some(ref source_filter) = query.source {
                let sources: Vec<&str> = source_filter.split(',').collect();
                if !sources.contains(&s.source.as_str()) {
                    return false;
                }
            }
            // Filter by search
            if let Some(ref search) = query.search {
                let q = search.to_lowercase();
                if !s.name.to_lowercase().contains(&q) && !s.description.to_lowercase().contains(&q)
                {
                    return false;
                }
            }
            true
        })
        .map(|s| {
            let installed = installed_file
                .installed
                .iter()
                .find(|i| i.repo_key == s.repo_key && i.repo_path == s.repo_path);

            let installed_count = installed
                .map(|i| {
                    i.global_agents.len()
                        + i.project_installs
                            .iter()
                            .map(|p| p.agents.len())
                            .sum::<usize>()
                })
                .unwrap_or(0);
            let status = if installed_count == 0 {
                "not_installed"
            } else if installed_count >= total_agents && total_agents > 0 {
                "installed"
            } else {
                "partial"
            };

            SkillSummaryResponse {
                name: s.name.clone(),
                description: s.description.clone(),
                source: s.source.clone(),
                repo_key: s.repo_key.clone(),
                relative_path: s.relative_path.clone(),
                repo_path: s.repo_path.clone(),
                install_status: status.to_string(),
                installed_agent_count: installed_count,
                total_agents,
                license: s.license.clone(),
                author: s.author.clone(),
            }
        })
        .collect();

    // Sort by name
    skills.sort_by(|a, b| a.name.cmp(&b.name));

    Json(skills)
}

/// GET /api/v1/skills/explore/{source}/{skill}
pub async fn get_skill_detail(Path((source, skill)): Path<(String, String)>) -> impl IntoResponse {
    let manifest = load_manifest();
    let entry = manifest
        .skills
        .iter()
        .find(|s| s.source == source && s.name == skill);

    let Some(entry) = entry else {
        return error_response(StatusCode::NOT_FOUND, "Skill not found").into_response();
    };

    // Read SKILL.md content
    let skill_md_content = ops::get_skill_md_content(&source, &entry.relative_path)
        .unwrap_or_else(|_| String::from("# Skill content not available"));

    let parsed = parse_skill_md(&skill_md_content);

    let installed_file = load_installed();
    let installed = installed_file
        .installed
        .iter()
        .find(|i| i.repo_key == entry.repo_key && i.repo_path == entry.repo_path);

    let installed_agents: Vec<String> = installed
        .map(|i| {
            let mut ids: Vec<String> = i.global_agents.iter().map(|a| a.agent_id.clone()).collect();
            for pi in &i.project_installs {
                ids.extend(pi.agents.iter().map(|a| a.agent_id.clone()));
            }
            ids
        })
        .unwrap_or_default();

    let all_agents = skills::get_all_agents();
    let total_agents = all_agents.iter().filter(|a| a.enabled).count();
    let installed_count = installed_agents.len();
    let status = if installed_count == 0 {
        "not_installed"
    } else if installed_count >= total_agents && total_agents > 0 {
        "installed"
    } else {
        "partial"
    };

    let fields = parsed
        .as_ref()
        .map(|p| {
            let mut m = p.metadata.clone();
            // Ensure author from manifest if not already present
            if let Some(author) = &entry.author {
                m.entry("author".to_string())
                    .or_insert_with(|| author.clone());
            }
            m
        })
        .unwrap_or_default();

    let metadata = SkillMetadataResponse {
        name: entry.name.clone(),
        description: entry.description.clone(),
        license: parsed
            .as_ref()
            .and_then(|p| p.license.clone())
            .or_else(|| entry.license.clone()),
        compatibility: parsed.as_ref().and_then(|p| p.compatibility.clone()),
        allowed_tools: parsed.as_ref().and_then(|p| p.allowed_tools.clone()),
        fields,
    };

    // Return body only (without frontmatter)
    let body_content = parsed.map(|p| p.body).unwrap_or(skill_md_content);

    Json(SkillDetailResponse {
        name: entry.name.clone(),
        description: entry.description.clone(),
        source: entry.source.clone(),
        repo_key: entry.repo_key.clone(),
        relative_path: entry.relative_path.clone(),
        repo_path: entry.repo_path.clone(),
        skill_md_content: body_content,
        metadata,
        install_status: status.to_string(),
        installed_agents,
    })
    .into_response()
}

/// GET /api/v1/skills/installed
pub async fn list_installed() -> impl IntoResponse {
    let installed_file = load_installed();
    let responses: Vec<InstalledSkillResponse> = installed_file
        .installed
        .iter()
        .map(installed_to_response)
        .collect();

    Json(responses)
}

/// POST /api/v1/skills/install
pub async fn install_skill(Json(req): Json<InstallSkillRequest>) -> impl IntoResponse {
    let install_req = ops::InstallRequest {
        repo_key: req.repo_key,
        source_name: req.source_name,
        skill_name: req.skill_name,
        repo_path: req.repo_path,
        relative_path: req.relative_path,
        scope: req.scope,
        agents: req
            .agents
            .into_iter()
            .map(|a| ops::InstallAgentEntry {
                agent_id: a.agent_id,
            })
            .collect(),
        project_path: req.project_path,
        force: req.force.unwrap_or(false),
    };

    match ops::install_skill(&install_req) {
        Ok(ops::InstallResult::Ok(installed)) => {
            Json(installed_to_response(&installed)).into_response()
        }
        Ok(ops::InstallResult::Conflict(conflict)) => (
            StatusCode::CONFLICT,
            Json(ConflictResponse {
                error: format!(
                    "Skill '{}' is already installed from source '{}'",
                    conflict.conflict_skill_name, conflict.conflict_source_name
                ),
                error_type: "skill_conflict".to_string(),
                conflict_source_name: conflict.conflict_source_name,
                conflict_skill_name: conflict.conflict_skill_name,
            }),
        )
            .into_response(),
        Err(e) => error_response(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()).into_response(),
    }
}

/// DELETE /api/v1/skills/installed/{repo_key}/{*repo_path}
pub async fn uninstall_skill(
    Path((repo_key, repo_path)): Path<(String, String)>,
) -> impl IntoResponse {
    match ops::uninstall_skill(&repo_key, &repo_path) {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(e) => error_response(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()).into_response(),
    }
}

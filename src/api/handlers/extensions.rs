//! Unified Extensions catalog and standalone MCP configuration/install APIs.

use axum::{extract::Query, http::StatusCode, response::IntoResponse, Json};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::api::error::ApiError;
use crate::storage::{extensions, skills};

#[derive(Debug, Deserialize)]
pub struct ExploreQuery {
    pub kind: Option<String>,
    pub search: Option<String>,
    pub source: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct ExtensionSummary {
    pub kind: String,
    pub name: String,
    pub description: String,
    pub version: Option<String>,
    pub source: String,
    pub repo_key: String,
    pub repo_path: String,
    pub relative_path: String,
    pub manifest: Value,
    pub install_status: String,
    pub installed_agents: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub installed_plugin_id: Option<String>,
}

/// GET /api/v1/extensions/explore
pub async fn explore(Query(query): Query<ExploreQuery>) -> impl IntoResponse {
    let mut out = Vec::new();
    let installed_skills = skills::load_installed();
    for skill in skills::load_manifest().skills {
        // Legacy plugin:* sources expose a Plugin's contributed skills as if
        // they were standalone packages. In the unified catalog the Plugin is
        // the install/manage boundary, so those children belong in its detail
        // view instead of appearing as duplicate top-level Extensions.
        if skill.source.starts_with("plugin:") {
            continue;
        }
        let installed = installed_skills
            .installed
            .iter()
            .find(|i| i.repo_key == skill.repo_key && i.repo_path == skill.repo_path);
        let mut agents = Vec::new();
        if let Some(installed) = installed {
            agents.extend(installed.global_agents.iter().map(|a| a.agent_id.clone()));
            for project in &installed.project_installs {
                agents.extend(project.agents.iter().map(|a| a.agent_id.clone()));
            }
            agents.sort();
            agents.dedup();
        }
        out.push(ExtensionSummary {
            kind: "skill".into(),
            name: skill.name,
            description: skill.description,
            version: None,
            source: skill.source,
            repo_key: skill.repo_key,
            repo_path: skill.repo_path,
            relative_path: skill.relative_path,
            manifest: Value::Null,
            install_status: if agents.is_empty() {
                "not_installed"
            } else {
                "installed"
            }
            .into(),
            installed_agents: agents,
            installed_plugin_id: None,
        });
    }

    let mcp_installs = extensions::list_mcp_installations().unwrap_or_default();
    let plugins = crate::storage::plugins::list().unwrap_or_default();
    let sources = skills::load_sources();
    for artifact in extensions::list_artifacts().unwrap_or_default() {
        let mut agents = Vec::new();
        let installed_plugin = if artifact.kind == "mcp" {
            agents = mcp_installs
                .iter()
                .filter(|i| i.repo_key == artifact.repo_key && i.repo_path == artifact.repo_path)
                .map(|i| i.agent_id.clone())
                .collect();
            agents.sort();
            agents.dedup();
            None
        } else {
            let source = sources
                .sources
                .iter()
                .find(|s| s.name == artifact.source_name);
            plugins.iter().find(|p| {
                p.name == artifact.name
                    && ((!artifact.repo_path.is_empty()
                        && std::path::Path::new(&p.local_path).ends_with(&artifact.repo_path))
                        || source.is_some_and(|s| {
                            p.git_url.as_deref() == Some(s.url.as_str())
                                && p.subpath.as_deref().unwrap_or("") == artifact.repo_path
                        }))
            })
        };
        let installed = if artifact.kind == "mcp" {
            !agents.is_empty()
        } else {
            installed_plugin.is_some()
        };
        out.push(ExtensionSummary {
            kind: artifact.kind,
            name: artifact.name,
            description: artifact.description,
            version: artifact.version,
            source: artifact.source_name,
            repo_key: artifact.repo_key,
            repo_path: artifact.repo_path,
            relative_path: artifact.relative_path,
            manifest: artifact.manifest,
            install_status: if installed {
                "installed"
            } else {
                "not_installed"
            }
            .into(),
            installed_agents: agents,
            installed_plugin_id: installed_plugin.map(|plugin| plugin.id.clone()),
        });
    }
    // Direct Add/Develop Plugin flows predate unified Sources. Surface those
    // installed/dev plugins as catalog entries too; their existing registry
    // remains authoritative until they are explicitly adopted by a Source.
    for plugin in &plugins {
        if out
            .iter()
            .any(|item| item.kind == "plugin" && item.name == plugin.name)
        {
            continue;
        }
        let manifest =
            std::fs::read_to_string(std::path::Path::new(&plugin.local_path).join("plugin.json"))
                .ok()
                .and_then(|raw| serde_json::from_str(&raw).ok())
                .unwrap_or(Value::Null);
        let description = manifest
            .get("description")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let version = manifest
            .get("version")
            .and_then(Value::as_str)
            .unwrap_or(&plugin.version)
            .to_string();
        out.push(ExtensionSummary {
            kind: "plugin".into(),
            name: plugin.name.clone(),
            description,
            version: Some(version),
            source: format!("plugin:{}", plugin.name),
            repo_key: plugin.id.clone(),
            repo_path: String::new(),
            relative_path: String::new(),
            manifest,
            install_status: "installed".into(),
            installed_agents: Vec::new(),
            installed_plugin_id: Some(plugin.id.clone()),
        });
    }

    out.retain(|item| {
        query
            .kind
            .as_ref()
            .is_none_or(|k| k == "all" || k == &item.kind)
            && query
                .source
                .as_ref()
                .is_none_or(|s| s.split(',').any(|x| x == item.source))
            && query.search.as_ref().is_none_or(|search| {
                let q = search.to_lowercase();
                item.name.to_lowercase().contains(&q)
                    || item.description.to_lowercase().contains(&q)
            })
    });
    out.sort_by_key(|a| a.name.to_lowercase());
    Json(out)
}

#[derive(Debug, Deserialize)]
pub struct CreateMcpRequest {
    /// A complete official MCP Registry server.json document.
    pub manifest: Value,
}

/// POST /api/v1/extensions/mcp — create an editable Grove-managed server.json.
pub async fn create_mcp(Json(req): Json<CreateMcpRequest>) -> impl IntoResponse {
    let Some(name) = req
        .manifest
        .get("name")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
    else {
        return ApiError::response(StatusCode::BAD_REQUEST, "server.json requires name");
    };
    let has_runtime = req
        .manifest
        .get("packages")
        .and_then(Value::as_array)
        .is_some_and(|a| !a.is_empty())
        || req
            .manifest
            .get("remotes")
            .and_then(Value::as_array)
            .is_some_and(|a| !a.is_empty());
    if !has_runtime {
        return ApiError::response(
            StatusCode::BAD_REQUEST,
            "server.json requires packages or remotes",
        );
    }

    let id = uuid::Uuid::new_v4().to_string();
    let dir = crate::storage::grove_dir()
        .join("sources")
        .join("managed")
        .join(&id);
    if let Err(error) = std::fs::create_dir_all(&dir).and_then(|_| {
        std::fs::write(
            dir.join("server.json"),
            serde_json::to_vec_pretty(&req.manifest).unwrap_or_default(),
        )
    }) {
        return ApiError::response(StatusCode::INTERNAL_SERVER_ERROR, error.to_string());
    }
    let source_name = format!("{}-{}", name.rsplit('/').next().unwrap_or("mcp"), &id[..8]);
    let url = dir.display().to_string();
    let mut sources = skills::load_sources();
    sources.sources.push(skills::SkillSourceDef {
        name: source_name.clone(),
        source_type: "local".into(),
        management_mode: "managed".into(),
        url: url.clone(),
        subpath: None,
        repo_key: skills::compute_repo_key(&url),
        last_synced: None,
        local_head: None,
    });
    if let Err(error) = skills::save_sources(&sources)
        .and_then(|_| crate::operations::skills::sync_source(&source_name).map(|_| ()))
    {
        return ApiError::response(StatusCode::INTERNAL_SERVER_ERROR, error.to_string());
    }
    (
        StatusCode::CREATED,
        Json(json!({ "ok": true, "source": source_name })),
    )
        .into_response()
}

#[derive(Debug, Deserialize)]
pub struct InstallMcpRequest {
    pub repo_key: String,
    pub repo_path: String,
    pub scope: String,
    #[serde(default)]
    pub project_path: Option<String>,
    pub agent_ids: Vec<String>,
    #[serde(default)]
    pub runtime: Value,
    #[serde(default)]
    pub values: Value,
}

/// POST /api/v1/extensions/mcp/install
pub async fn install_mcp(Json(req): Json<InstallMcpRequest>) -> impl IntoResponse {
    let artifact = match extensions::get_artifact(&req.repo_key, &req.repo_path, "mcp") {
        Ok(Some(a)) => a,
        Ok(None) => return ApiError::response(StatusCode::NOT_FOUND, "MCP artifact not found"),
        Err(e) => return ApiError::response(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    };
    if req.scope != "global" && req.scope != "project" {
        return ApiError::response(StatusCode::BAD_REQUEST, "scope must be global or project");
    }
    let project_path = if req.scope == "project" {
        match req.project_path.as_deref().filter(|p| !p.is_empty()) {
            Some(p) => p,
            None => {
                return ApiError::response(
                    StatusCode::BAD_REQUEST,
                    "project_path is required for project scope",
                )
            }
        }
    } else {
        ""
    };
    for id in &req.agent_ids {
        if crate::storage::installed_agents::get(id)
            .ok()
            .flatten()
            .is_none()
        {
            return ApiError::response(
                StatusCode::BAD_REQUEST,
                format!("ACP Agent is not installed: {id}"),
            );
        }
    }
    match extensions::save_mcp_installations(
        &req.repo_key,
        &req.repo_path,
        &artifact.source_name,
        &req.scope,
        project_path,
        &req.agent_ids,
        &req.runtime,
        &req.values,
    ) {
        Ok(()) => Json(json!({ "ok": true })).into_response(),
        Err(e) => ApiError::response(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

pub async fn list_mcp_installed() -> impl IntoResponse {
    match extensions::list_mcp_installations() {
        Ok(items) => Json(items).into_response(),
        Err(e) => ApiError::response(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

#[derive(Debug, Deserialize)]
pub struct InstallPluginRequest {
    pub repo_key: String,
    pub repo_path: String,
}

/// POST /api/v1/extensions/plugin/install
pub async fn install_plugin(Json(req): Json<InstallPluginRequest>) -> impl IntoResponse {
    let artifact = match extensions::get_artifact(&req.repo_key, &req.repo_path, "plugin") {
        Ok(Some(a)) => a,
        Ok(None) => return ApiError::response(StatusCode::NOT_FOUND, "Plugin artifact not found"),
        Err(e) => return ApiError::response(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    };
    let sources = skills::load_sources();
    let Some(source) = sources
        .sources
        .iter()
        .find(|s| s.name == artifact.source_name)
    else {
        return ApiError::response(StatusCode::NOT_FOUND, "Plugin source not found");
    };
    let root = if source.source_type == "git" {
        skills::repos_dir().join(&source.repo_key)
    } else {
        std::path::PathBuf::from(crate::storage::workspace::expand_tilde(&source.url))
    };
    let path = root.join(&artifact.repo_path);
    let result = crate::api::handlers::plugins::install_plugin_from_source(
        &path,
        if source.source_type == "git" {
            "git"
        } else {
            "local"
        },
        (source.source_type == "git").then_some(source.url.as_str()),
        (!artifact.repo_path.is_empty()).then_some(artifact.repo_path.as_str()),
    )
    .await;
    match result {
        Ok(plugin) => Json(json!({ "ok": true, "plugin": plugin })).into_response(),
        Err(error) => error.into_response(),
    }
}

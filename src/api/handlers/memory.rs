//! Project-level Memory configuration and UI read API.

use axum::{
    extract::{Path, Query},
    http::StatusCode,
    Json,
};
use chrono::Utc;
use serde::{Deserialize, Serialize};

use crate::automation::cron_util;
use crate::memory::organization::ORGANIZATION_PROMPT;
use crate::storage::{
    automations::{
        self, AgentConfigSelection, Automation, TargetMode, MEMORY_ORGANIZATION_HANDLER,
    },
    installed_agents, memory,
};

use super::common::find_project_by_id;

#[derive(Debug, Serialize)]
pub struct MemoryAutomationConfig {
    pub id: String,
    pub enabled: bool,
    pub agent_config: AgentConfigSelection,
    pub schedule_cron: String,
    pub event_triggers: Vec<String>,
    pub next_run_at: Option<i64>,
}

#[derive(Debug, Serialize)]
pub struct MemoryConfigResponse {
    pub project_id: String,
    pub enabled: bool,
    pub deep_organization: bool,
    pub pending_log_threshold: Option<i64>,
    pub organization: MemoryAutomationConfig,
}

#[derive(Debug, Deserialize)]
pub struct UpdateMemoryConfig {
    pub enabled: bool,
    pub deep_organization: bool,
    pub pending_log_threshold: Option<i64>,
    pub organization_enabled: bool,
    pub agent_config: AgentConfigSelection,
    pub schedule_cron: String,
    #[serde(default)]
    pub event_triggers: Vec<String>,
}

#[derive(Debug, Deserialize)]
pub struct MemoryListQuery {
    pub q: Option<String>,
    pub cursor: Option<String>,
    pub limit: Option<usize>,
}

#[derive(Debug, Deserialize)]
pub struct RelationListQuery {
    pub entity_id: Option<String>,
    pub cursor: Option<String>,
    pub limit: Option<usize>,
}

#[derive(Debug, Serialize)]
pub struct MemoryRelationsResponse {
    pub items: Vec<memory::MemoryRelation>,
    pub next_cursor: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct MemoryRunHistoryResponse {
    pub events: Vec<serde_json::Value>,
    pub usage: memory::MemoryUsageTotals,
}

#[derive(Debug, Deserialize)]
pub struct DeleteMemoryLogs {
    pub ids: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct DeleteMemoryLogsResponse {
    pub deleted: usize,
}

#[derive(Debug, Deserialize)]
pub struct ResolveMemoryEntities {
    pub entity_ids: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct MemoryEntityMetadata {
    pub entity_id: String,
    pub title: String,
    pub tags: Vec<memory::MemoryTag>,
}

#[derive(Debug, Serialize)]
pub struct ResolveMemoryEntitiesResponse {
    pub items: Vec<MemoryEntityMetadata>,
}

pub async fn get_config(
    Path(project_id): Path<String>,
) -> Result<Json<MemoryConfigResponse>, (StatusCode, String)> {
    let (_, project_key) =
        find_project_by_id(&project_id).map_err(|status| (status, "project not found".into()))?;
    let config = memory::get_project_config(&project_key)
        .map_err(internal)?
        .ok_or((StatusCode::NOT_FOUND, "Memory is not configured".into()))?;
    let mut automation = automations::get(&config.organization_automation_id)
        .map_err(internal)?
        .ok_or((StatusCode::CONFLICT, "linked Automation is missing".into()))?;
    let reconciled = automation
        .agent_config
        .reconciled_with_installed_snapshot()
        .map_err(internal)?;
    if reconciled != automation.agent_config {
        automation.agent_config = reconciled;
        automation.updated_at = Utc::now().timestamp();
        automations::update(&automation).map_err(internal)?;
    }
    Ok(Json(to_response(config, automation)))
}

pub async fn update_config(
    Path(project_id): Path<String>,
    Json(input): Json<UpdateMemoryConfig>,
) -> Result<Json<MemoryConfigResponse>, (StatusCode, String)> {
    let (_, project_key) =
        find_project_by_id(&project_id).map_err(|status| (status, "project not found".into()))?;
    cron_util::validate(&input.schedule_cron).map_err(|error| (StatusCode::BAD_REQUEST, error))?;
    if input.enabled {
        let agent_id = input
            .agent_config
            .agent_id()
            .filter(|id| !id.trim().is_empty())
            .ok_or((
                StatusCode::BAD_REQUEST,
                "agent_config.agent_id is required".into(),
            ))?;
        let canonical_agent = installed_agents::canonicalize_agent_id(agent_id);
        if installed_agents::get(&canonical_agent)
            .map_err(internal)?
            .is_none()
        {
            return Err((
                StatusCode::BAD_REQUEST,
                format!("agent '{agent_id}' is not installed"),
            ));
        }
    }

    let now = Utc::now().timestamp();
    let existing_config = memory::get_project_config(&project_key).map_err(internal)?;
    let mut automation = if let Some(config) = existing_config.as_ref() {
        automations::get(&config.organization_automation_id)
            .map_err(internal)?
            .ok_or((StatusCode::CONFLICT, "linked Automation is missing".into()))?
    } else {
        Automation {
            id: automations::generate_id(),
            project: project_key.clone(),
            name: "Memory Organization".to_string(),
            enabled: false,
            handler_key: MEMORY_ORGANIZATION_HANDLER.to_string(),
            agent_config: AgentConfigSelection::default(),
            // Legacy Task/Chat columns remain populated but are never read by
            // a Consumer Handler and never create a hidden Task or Chat.
            task_mode: TargetMode::Existing,
            task_id: None,
            task_template: None,
            session_mode: TargetMode::Existing,
            chat_id: None,
            session_template: None,
            prompt: ORGANIZATION_PROMPT.to_string(),
            schedule_cron: input.schedule_cron.clone(),
            event_triggers: Vec::new(),
            window: Default::default(),
            last_run_at: None,
            last_run_status: None,
            last_run_error: None,
            next_run_at: None,
            created_at: now,
            updated_at: now,
        }
    };
    let pending_log_threshold = input.pending_log_threshold.filter(|value| *value > 0);
    automation.enabled = input.enabled && input.organization_enabled;
    automation.agent_config = input
        .agent_config
        .reconciled_with_installed_snapshot()
        .map_err(internal)?;
    automation.prompt = ORGANIZATION_PROMPT.to_string();
    automation.schedule_cron = input.schedule_cron;
    let mut event_triggers = normalize_events(input.event_triggers)?;
    event_triggers.retain(|event| event != memory::PENDING_LOG_THRESHOLD_EVENT);
    if pending_log_threshold.is_some() {
        event_triggers.push(memory::PENDING_LOG_THRESHOLD_EVENT.to_string());
    }
    automation.event_triggers = event_triggers;
    automation.next_run_at = if automation.enabled {
        cron_util::next_unix(&automation.schedule_cron)
            .map_err(|error| (StatusCode::BAD_REQUEST, error))?
    } else {
        None
    };
    automation.updated_at = now;

    let config = memory::MemoryProjectConfig {
        project_id: project_key,
        enabled: input.enabled,
        deep_organization: input.deep_organization,
        pending_log_threshold,
        organization_automation_id: automation.id.clone(),
        last_input_through_at: existing_config
            .as_ref()
            .and_then(|config| config.last_input_through_at.clone()),
        created_at: existing_config
            .as_ref()
            .map(|config| config.created_at.clone())
            .unwrap_or_else(|| Utc::now().to_rfc3339()),
        updated_at: Utc::now().to_rfc3339(),
    };
    memory::save_project_config_with_automation(&config, &automation).map_err(internal)?;
    memory::emit_pending_log_threshold_if_needed(&config.project_id).map_err(internal)?;
    Ok(Json(to_response(config, automation)))
}

pub async fn overview(
    Path(project_id): Path<String>,
) -> Result<Json<memory::MemoryOverview>, (StatusCode, String)> {
    let (_, project_key) =
        find_project_by_id(&project_id).map_err(|status| (status, "project not found".into()))?;
    let automation_id = memory::get_project_config(&project_key)
        .map_err(internal)?
        .map(|config| config.organization_automation_id)
        .unwrap_or_default();
    Ok(Json(
        memory::get_overview(&project_key, &automation_id).map_err(internal)?,
    ))
}

pub async fn list_entities(
    Path(project_id): Path<String>,
    Query(query): Query<MemoryListQuery>,
) -> Result<Json<memory::Page<memory::MemoryEntity>>, (StatusCode, String)> {
    let (_, project_key) =
        find_project_by_id(&project_id).map_err(|status| (status, "project not found".into()))?;
    Ok(Json(
        memory::list_entities(
            &project_key,
            query.q.as_deref(),
            query.cursor.as_deref(),
            query.limit.unwrap_or(40),
        )
        .map_err(internal)?,
    ))
}

pub async fn get_entity(
    Path((project_id, entity_id)): Path<(String, String)>,
) -> Result<Json<memory::MemoryEntityDocument>, (StatusCode, String)> {
    let (_, project_key) =
        find_project_by_id(&project_id).map_err(|status| (status, "project not found".into()))?;
    memory::get_entity_document(&project_key, &entity_id)
        .map_err(internal)?
        .map(Json)
        .ok_or((StatusCode::NOT_FOUND, "Memory not found".into()))
}

pub async fn resolve_entities(
    Path(project_id): Path<String>,
    Json(input): Json<ResolveMemoryEntities>,
) -> Result<Json<ResolveMemoryEntitiesResponse>, (StatusCode, String)> {
    let (_, project_key) =
        find_project_by_id(&project_id).map_err(|status| (status, "project not found".into()))?;
    if input.entity_ids.is_empty() || input.entity_ids.len() > 200 {
        return Err((
            StatusCode::BAD_REQUEST,
            "entity_ids must contain between 1 and 200 Memory Entity IDs".into(),
        ));
    }
    let mut seen = std::collections::HashSet::new();
    let entity_ids = input
        .entity_ids
        .into_iter()
        .map(|entity_id| entity_id.trim().to_string())
        .filter(|entity_id| !entity_id.is_empty() && seen.insert(entity_id.clone()))
        .collect::<Vec<_>>();
    if entity_ids.is_empty() {
        return Err((
            StatusCode::BAD_REQUEST,
            "entity_ids must not be empty".into(),
        ));
    }
    let items = memory::resolve_entities(&project_key, &entity_ids)
        .map_err(internal)?
        .into_iter()
        .map(|entity| MemoryEntityMetadata {
            entity_id: entity.entity_id,
            title: entity.title,
            tags: entity.tags,
        })
        .collect();
    Ok(Json(ResolveMemoryEntitiesResponse { items }))
}

pub async fn delete_entity(
    Path((project_id, entity_id)): Path<(String, String)>,
) -> Result<StatusCode, (StatusCode, String)> {
    let (_, project_key) =
        find_project_by_id(&project_id).map_err(|status| (status, "project not found".into()))?;
    ensure_no_active_run(&project_key)?;
    if !memory::delete_entity(&project_key, &entity_id).map_err(internal)? {
        return Err((StatusCode::NOT_FOUND, "Memory not found".into()));
    }
    Ok(StatusCode::NO_CONTENT)
}

pub async fn list_logs(
    Path(project_id): Path<String>,
    Query(query): Query<MemoryListQuery>,
) -> Result<Json<memory::Page<memory::MemoryLog>>, (StatusCode, String)> {
    let (_, project_key) =
        find_project_by_id(&project_id).map_err(|status| (status, "project not found".into()))?;
    Ok(Json(
        memory::list_logs(
            &project_key,
            query.q.as_deref(),
            query.cursor.as_deref(),
            query.limit.unwrap_or(40),
        )
        .map_err(internal)?,
    ))
}

pub async fn delete_logs(
    Path(project_id): Path<String>,
    Json(input): Json<DeleteMemoryLogs>,
) -> Result<Json<DeleteMemoryLogsResponse>, (StatusCode, String)> {
    let (_, project_key) =
        find_project_by_id(&project_id).map_err(|status| (status, "project not found".into()))?;
    ensure_no_active_run(&project_key)?;
    if input.ids.is_empty() || input.ids.len() > 200 {
        return Err((
            StatusCode::BAD_REQUEST,
            "ids must contain between 1 and 200 Memory Log IDs".into(),
        ));
    }
    Ok(Json(DeleteMemoryLogsResponse {
        deleted: memory::delete_logs(&project_key, &input.ids).map_err(internal)?,
    }))
}

pub async fn list_relations(
    Path(project_id): Path<String>,
    Query(query): Query<RelationListQuery>,
) -> Result<Json<MemoryRelationsResponse>, (StatusCode, String)> {
    let (_, project_key) =
        find_project_by_id(&project_id).map_err(|status| (status, "project not found".into()))?;
    let offset = query
        .cursor
        .as_deref()
        .filter(|value| !value.is_empty())
        .map(str::parse::<usize>)
        .transpose()
        .map_err(|_| (StatusCode::BAD_REQUEST, "invalid cursor".into()))?
        .unwrap_or(0);
    let limit = query.limit.unwrap_or(40).clamp(1, 100);
    let mut items =
        memory::list_relations(&project_key, query.entity_id.as_deref(), limit + 1, offset)
            .map_err(internal)?;
    let has_more = items.len() > limit;
    if has_more {
        items.truncate(limit);
    }
    Ok(Json(MemoryRelationsResponse {
        items,
        next_cursor: has_more.then(|| (offset + limit).to_string()),
    }))
}

pub async fn run_history(
    Path((project_id, run_id)): Path<(String, String)>,
) -> Result<Json<MemoryRunHistoryResponse>, (StatusCode, String)> {
    let (_, project_key) =
        find_project_by_id(&project_id).map_err(|status| (status, "project not found".into()))?;
    let config = memory::get_project_config(&project_key)
        .map_err(internal)?
        .ok_or((StatusCode::NOT_FOUND, "Memory is not configured".into()))?;
    let run = automations::get_run(&run_id)
        .map_err(internal)?
        .filter(|run| run.automation_id == config.organization_automation_id)
        .ok_or((StatusCode::NOT_FOUND, "Memory Run not found".into()))?;
    let _ = run;
    Ok(Json(MemoryRunHistoryResponse {
        events: memory::read_run_history(&project_key, &run_id).map_err(internal)?,
        usage: memory::get_run_usage(&run_id).map_err(internal)?,
    }))
}

pub async fn delete_run(
    Path((project_id, run_id)): Path<(String, String)>,
) -> Result<StatusCode, (StatusCode, String)> {
    let (_, project_key) =
        find_project_by_id(&project_id).map_err(|status| (status, "project not found".into()))?;
    let config = memory::get_project_config(&project_key)
        .map_err(internal)?
        .ok_or((StatusCode::NOT_FOUND, "Memory is not configured".into()))?;
    let run = automations::get_run(&run_id)
        .map_err(internal)?
        .filter(|run| run.automation_id == config.organization_automation_id)
        .ok_or((StatusCode::NOT_FOUND, "Memory Run not found".into()))?;
    if matches!(run.status.as_str(), "queued" | "running" | "cancelling") {
        return Err((
            StatusCode::CONFLICT,
            "Active Memory Runs must be cancelled before deletion".into(),
        ));
    }
    if !automations::delete_finished_run(&config.organization_automation_id, &run_id)
        .map_err(internal)?
    {
        return Err((StatusCode::NOT_FOUND, "Memory Run not found".into()));
    }
    Ok(StatusCode::NO_CONTENT)
}

fn normalize_events(events: Vec<String>) -> Result<Vec<String>, (StatusCode, String)> {
    let mut result = Vec::new();
    for event in events {
        let event = event.trim();
        if event.is_empty()
            || !event
                .chars()
                .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-'))
        {
            return Err((
                StatusCode::BAD_REQUEST,
                format!("invalid event trigger: {event}"),
            ));
        }
        if !result.iter().any(|existing| existing == event) {
            result.push(event.to_string());
        }
    }
    Ok(result)
}

fn ensure_no_active_run(project_id: &str) -> Result<(), (StatusCode, String)> {
    let Some(config) = memory::get_project_config(project_id).map_err(internal)? else {
        return Ok(());
    };
    if automations::has_active_run(&config.organization_automation_id).map_err(internal)? {
        return Err((
            StatusCode::CONFLICT,
            "Wait for the running or waiting Memory organization attempt to finish or cancel it first".into(),
        ));
    }
    Ok(())
}

fn to_response(
    config: memory::MemoryProjectConfig,
    automation: Automation,
) -> MemoryConfigResponse {
    MemoryConfigResponse {
        project_id: config.project_id,
        enabled: config.enabled,
        deep_organization: config.deep_organization,
        pending_log_threshold: config.pending_log_threshold,
        organization: MemoryAutomationConfig {
            id: automation.id,
            enabled: automation.enabled,
            agent_config: automation.agent_config,
            schedule_cron: automation.schedule_cron,
            event_triggers: automation
                .event_triggers
                .into_iter()
                .filter(|event| event != memory::PENDING_LOG_THRESHOLD_EVENT)
                .collect(),
            next_run_at: automation.next_run_at,
        },
    }
}

fn internal(error: crate::error::GroveError) -> (StatusCode, String) {
    (StatusCode::INTERNAL_SERVER_ERROR, error.to_string())
}

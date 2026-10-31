//! Grove Memory persistence.
//!
//! Working agents append immutable logs while operating inside a task/chat.
//! Long-term Project Memory remains directly editable Markdown; SQLite holds
//! only its list/search projection, relations and explicit access counters.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{BufRead, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

use chrono::Utc;
use rusqlite::{params, OptionalExtension};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use super::database;
use crate::error::{GroveError, Result};

#[derive(Debug)]
pub struct NewMemoryLog<'a> {
    pub project_id: &'a str,
    pub task_id: &'a str,
    pub chat_id: Option<&'a str>,
    pub agent: Option<&'a str>,
    pub title: &'a str,
    pub tags: &'a [String],
    pub description: &'a str,
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct MemoryLog {
    /// Stable Log id.
    pub id: String,
    /// Trusted Project id derived by Grove.
    pub project_id: String,
    /// Trusted Task id derived by Grove.
    pub task_id: String,
    /// Source chat when available.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub chat_id: Option<String>,
    /// Source Agent when available.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent: Option<String>,
    /// Concise short-term observation title.
    pub title: String,
    /// Flat short-term topic labels.
    pub tags: Vec<String>,
    /// Observation details supplied by the Working Agent.
    pub description: String,
    /// RFC 3339 creation timestamp.
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, JsonSchema)]
pub struct MemoryTag {
    /// Structured tag category.
    pub key: String,
    /// Value inside the tag category.
    pub value: String,
    /// Optional presentation icon for this Tag.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct MemoryFrontmatter {
    title: String,
    description: String,
    #[serde(default)]
    tags: Vec<MemoryTag>,
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct MemoryEntity {
    /// Trusted Project id.
    pub project_id: String,
    /// Stable managed Entity id.
    pub entity_id: String,
    /// Project-relative Markdown path.
    pub file_path: String,
    /// Entity title from Markdown frontmatter.
    pub title: String,
    /// Summary used for recall and preview before reading the body.
    pub description: String,
    /// Structured Markdown frontmatter tags.
    pub tags: Vec<MemoryTag>,
    /// Organizer-assigned importance from 0 through 80 inclusive.
    #[schemars(range(min = 0, max = 80))]
    pub base_score: i64,
    /// Number of successful full-body reads.
    #[schemars(range(min = 0))]
    pub access_count: i64,
    /// Current score: base_score + min(access_count, 20), from 0 through 100.
    #[schemars(range(min = 0, max = 100))]
    pub score: i64,
    /// RFC 3339 creation timestamp.
    pub created_at: String,
    /// RFC 3339 projection update timestamp.
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct MemoryEntityDocument {
    /// Entity metadata after recording this read.
    #[serde(flatten)]
    pub entity: MemoryEntity,
    /// Full Markdown body without frontmatter.
    pub body: String,
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct RelatedMemory {
    /// Relation connecting the requested Entity to the related Entity.
    pub relation: MemoryRelation,
    /// Related Entity summary metadata; the Markdown body is not included.
    pub entity: MemoryEntity,
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct MemoryReadResult {
    /// Requested Entity with full Markdown body.
    pub entity: MemoryEntityDocument,
    /// Highest-scoring related Entity summaries, without bodies.
    pub related: Vec<RelatedMemory>,
    /// Whether via_relation_id identified an incident Relation and its access was recorded.
    pub relation_access_recorded: bool,
}

#[derive(Debug, Clone)]
pub struct MemoryTagFilter {
    pub key: String,
    pub value: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct MemoryUsageTotals {
    pub input_tokens: i64,
    pub cached_input_tokens: i64,
    pub output_tokens: i64,
    pub total_tokens: i64,
    pub cost_by_currency: HashMap<String, f64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct MemoryOverview {
    pub entity_count: i64,
    pub relation_count: i64,
    pub log_count: i64,
    pub run_count: i64,
    pub successful_run_count: i64,
    pub failed_run_count: i64,
    pub in_progress_run_count: i64,
    pub waiting_run_count: i64,
    pub active_run_count: i64,
    pub last_organized_at: Option<i64>,
    pub usage: MemoryUsageTotals,
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct CreatedMemoryEntity {
    /// Created Entity metadata.
    #[serde(flatten)]
    pub entity: MemoryEntity,
    /// Absolute managed Markdown path for filesystem editing.
    pub absolute_path: String,
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct MemoryRelation {
    /// Stable Relation id.
    pub id: String,
    /// Trusted Project id.
    pub project_id: String,
    /// Directed source Entity id.
    pub source_entity_id: String,
    /// Directed target Entity id.
    pub target_entity_id: String,
    /// Semantic Relation type.
    pub relation_type: String,
    /// Human-readable explanation of the connection.
    pub description: String,
    /// Organizer-assigned importance from 0 through 80 inclusive.
    #[schemars(range(min = 0, max = 80))]
    pub base_score: i64,
    /// Number of full reads that explicitly followed this Relation.
    #[schemars(range(min = 0))]
    pub access_count: i64,
    /// Current score: base_score + min(access_count, 20), from 0 through 100.
    #[schemars(range(min = 0, max = 100))]
    pub score: i64,
    /// RFC 3339 creation timestamp.
    pub created_at: String,
    /// RFC 3339 update timestamp.
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ProjectionSyncResult {
    pub updated: usize,
    pub deleted: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemoryProjectConfig {
    pub project_id: String,
    pub enabled: bool,
    pub deep_organization: bool,
    pub pending_log_threshold: Option<i64>,
    pub organization_automation_id: String,
    pub last_input_through_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct RecentChatFile {
    /// Source Task id.
    pub task_id: String,
    /// Source chat id.
    pub chat_id: String,
    /// Absolute history.jsonl path.
    pub path: String,
    /// RFC 3339 file modification timestamp.
    pub modified_at: String,
    /// Human-readable Task name for evidence orientation.
    pub task_name: String,
    /// Human-readable Session title for evidence orientation.
    pub session_name: String,
    /// One-based line where evidence after the previous successful
    /// organization begins. This is a dynamic reading hint, not a cursor.
    pub new_content_start_line: usize,
    /// Current JSONL line count, useful for choosing an efficient read method.
    pub total_lines: usize,
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct Page<T> {
    /// Current page items.
    pub items: Vec<T>,
    /// Opaque cursor for the next page; absent when there is no next page.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<String>,
}

#[derive(Debug, Clone)]
pub enum RelationOperation {
    Upsert {
        id: Option<String>,
        source_entity_id: String,
        target_entity_id: String,
        relation_type: String,
        description: String,
        base_score: i64,
    },
    Delete {
        relation_id: String,
    },
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum RelationOperationResult {
    /// Created or updated Relation.
    Upsert {
        /// Persisted Relation after the operation.
        relation: MemoryRelation,
    },
    /// Relation deletion result.
    Delete {
        /// Requested Relation id.
        relation_id: String,
        /// Whether the Relation existed and was deleted.
        deleted: bool,
    },
}

/// Append one immutable short-term memory log.
pub fn append_log(input: &NewMemoryLog<'_>) -> Result<MemoryLog> {
    let project_id = required(input.project_id, "project_id")?;
    let task_id = required(input.task_id, "task_id")?;
    let title = required(input.title, "title")?;
    let description = required(input.description, "description")?;
    let tags = normalize_tags(input.tags);
    let tags_json = serde_json::to_string(&tags)?;

    let log = MemoryLog {
        id: format!("memory-log-{}", Uuid::new_v4()),
        project_id,
        task_id,
        chat_id: non_empty(input.chat_id),
        agent: non_empty(input.agent),
        title,
        tags,
        description,
        created_at: Utc::now().to_rfc3339(),
    };

    let conn = database::connection();
    conn.execute(
        "INSERT INTO memory_logs (
            id, project_id, task_id, chat_id, agent,
            title, tags_json, description, created_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![
            log.id,
            log.project_id,
            log.task_id,
            log.chat_id,
            log.agent,
            log.title,
            tags_json,
            log.description,
            log.created_at,
        ],
    )?;
    drop(conn);
    emit_pending_log_threshold_if_needed(&log.project_id)?;

    Ok(log)
}

pub const PENDING_LOG_THRESHOLD_EVENT: &str = "memory.pending_logs.threshold";

/// Notify the linked Automation when the optional pending-Log threshold is
/// active and currently satisfied. Automation owns Single Flight, so callers
/// may safely invoke this after every append and after a committed Run.
pub fn emit_pending_log_threshold_if_needed(project_id: &str) -> Result<bool> {
    let Some(config) = get_project_config(project_id)? else {
        return Ok(false);
    };
    let Some(threshold) = config.pending_log_threshold.filter(|value| *value > 0) else {
        return Ok(false);
    };
    if !config.enabled {
        return Ok(false);
    }
    let count = database::connection().query_row(
        "SELECT COUNT(*) FROM memory_logs WHERE project_id = ?1",
        params![project_id],
        |row| row.get::<_, i64>(0),
    )?;
    if count < threshold {
        return Ok(false);
    }
    crate::automation::events::emit(
        project_id.to_string(),
        PENDING_LOG_THRESHOLD_EVENT,
        serde_json::json!({ "pending_logs": count, "threshold": threshold }),
    );
    Ok(true)
}

pub fn memory_dir(project_id: &str) -> Result<PathBuf> {
    validate_path_segment(project_id, "project_id")?;
    Ok(super::grove_dir()
        .join("projects")
        .join(project_id)
        .join("memory"))
}

pub fn entities_dir(project_id: &str) -> Result<PathBuf> {
    Ok(memory_dir(project_id)?.join("entities"))
}

pub fn ensure_entities_dir(project_id: &str) -> Result<PathBuf> {
    let path = entities_dir(project_id)?;
    fs::create_dir_all(&path)?;
    Ok(path)
}

pub fn runs_dir(project_id: &str) -> Result<PathBuf> {
    Ok(memory_dir(project_id)?.join("runs"))
}

pub fn create_entity(
    project_id: &str,
    title: &str,
    description: &str,
    tags: &[MemoryTag],
    base_score: i64,
) -> Result<CreatedMemoryEntity> {
    let project_id = required(project_id, "project_id")?;
    let title = required(title, "title")?;
    let description = required(description, "description")?;
    validate_base_score(base_score)?;
    let tags = normalize_memory_tags(tags)?;
    let entity_id = format!("memory-{}", Uuid::new_v4());
    let file_path = format!("entities/{entity_id}.md");
    let absolute_path = ensure_entities_dir(&project_id)?.join(format!("{entity_id}.md"));
    let raw = render_markdown(&MemoryFrontmatter {
        title: title.clone(),
        description: description.clone(),
        tags: tags.clone(),
    })?;
    atomic_write(&absolute_path, raw.as_bytes())?;

    let now = Utc::now().to_rfc3339();
    let tags_json = serde_json::to_string(&tags)?;
    let result = database::connection().execute(
        "INSERT INTO memory_entities (
            project_id, entity_id, file_path, title, description, tags_json,
            content_hash, base_score, access_count, created_at, updated_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 0, ?9, ?9)",
        params![
            project_id,
            entity_id,
            file_path,
            title,
            description,
            tags_json,
            content_hash(raw.as_bytes()),
            base_score,
            now,
        ],
    );
    if let Err(error) = result {
        let _ = fs::remove_file(&absolute_path);
        return Err(error.into());
    }
    let entity = get_entity(&project_id, &entity_id)?
        .ok_or_else(|| GroveError::storage("created Memory Entity disappeared"))?;
    Ok(CreatedMemoryEntity {
        entity,
        absolute_path: absolute_path.to_string_lossy().into_owned(),
    })
}

/// Update metadata through Grove's YAML serializer. The Markdown body is kept
/// byte-for-byte, and the existing projection is refreshed on publication.
pub fn update_entity_metadata(
    project_id: &str,
    entity_id: &str,
    title: Option<&str>,
    description: Option<&str>,
    tags: Option<&[MemoryTag]>,
) -> Result<()> {
    validate_path_segment(project_id, "project_id")?;
    validate_path_segment(entity_id, "entity_id")?;
    if title.is_none() && description.is_none() && tags.is_none() {
        return Err(GroveError::invalid_data(
            "Provide at least one metadata field to update",
        ));
    }
    let entity = get_entity(project_id, entity_id)?
        .ok_or_else(|| GroveError::not_found(format!("Memory Entity {entity_id}")))?;
    let path = entity_absolute_path(project_id, &entity.file_path)?;
    let raw = fs::read_to_string(&path)?;
    parse_memory_file(&raw, &path)?;
    let (yaml, body) = raw
        .strip_prefix("---\n")
        .unwrap()
        .split_once("\n---\n")
        .unwrap();
    let mut fields: serde_yaml::Mapping = serde_yaml::from_str(yaml)
        .map_err(|error| GroveError::invalid_data(format!("parse Memory frontmatter: {error}")))?;
    if let Some(title) = title {
        fields.insert("title".into(), required(title, "title")?.into());
    }
    if let Some(description) = description {
        fields.insert(
            "description".into(),
            required(description, "description")?.into(),
        );
    }
    if let Some(tags) = tags {
        let normalized = normalize_memory_tags(tags)?;
        fields.insert(
            "tags".into(),
            serde_yaml::to_value(normalized).map_err(|error| {
                GroveError::invalid_data(format!("serialize Memory tags: {error}"))
            })?,
        );
    }
    let yaml = serde_yaml::to_string(&fields).map_err(|error| {
        GroveError::invalid_data(format!("serialize Memory frontmatter: {error}"))
    })?;
    let updated = format!("---\n{yaml}---\n{body}");
    parse_memory_file(&updated, &path)?;
    if fs::read_to_string(&path)? != raw {
        return Err(GroveError::invalid_data(
            "Memory file changed during metadata update; retry with the latest contents",
        ));
    }
    atomic_write(&path, updated.as_bytes())
}

pub fn delete_entity(project_id: &str, entity_id: &str) -> Result<bool> {
    validate_path_segment(project_id, "project_id")?;
    validate_path_segment(entity_id, "entity_id")?;
    let Some(entity) = get_entity(project_id, entity_id)? else {
        return Ok(false);
    };
    let absolute = entity_absolute_path(project_id, &entity.file_path)?;
    let staged = absolute.with_extension(format!("md.deleting-{}", Uuid::new_v4()));
    if absolute.exists() {
        fs::rename(&absolute, &staged)?;
    }
    let conn = database::connection();
    let tx = conn.unchecked_transaction()?;
    let result = tx.execute(
        "DELETE FROM memory_entities WHERE project_id = ?1 AND entity_id = ?2",
        params![project_id, entity_id],
    );
    match result {
        Ok(count) => {
            if let Err(error) = tx.commit() {
                if staged.exists() {
                    let _ = fs::rename(&staged, &absolute);
                }
                return Err(error.into());
            }
            if staged.exists() {
                // The managed Entity is already deleted transactionally. A
                // leftover staging file is harmless and must not turn the
                // committed deletion into a reported failure.
                let _ = fs::remove_file(staged);
            }
            Ok(count > 0)
        }
        Err(error) => {
            drop(tx);
            if staged.exists() {
                let _ = fs::rename(&staged, &absolute);
            }
            Err(error.into())
        }
    }
}

pub fn get_entity(project_id: &str, entity_id: &str) -> Result<Option<MemoryEntity>> {
    let conn = database::connection();
    conn.query_row(
        "SELECT project_id, entity_id, file_path, title, description, tags_json,
                base_score, access_count,
                base_score + MIN(access_count, 20), created_at, updated_at
         FROM memory_entities WHERE project_id = ?1 AND entity_id = ?2",
        params![project_id, entity_id],
        row_to_entity,
    )
    .optional()
    .map_err(Into::into)
}

pub fn resolve_entities(project_id: &str, entity_ids: &[String]) -> Result<Vec<MemoryEntity>> {
    validate_path_segment(project_id, "project_id")?;
    if entity_ids.is_empty() {
        return Ok(Vec::new());
    }
    for entity_id in entity_ids {
        validate_path_segment(entity_id, "entity_id")?;
    }

    let placeholders = vec!["?"; entity_ids.len()].join(", ");
    let sql = format!(
        "SELECT project_id, entity_id, file_path, title, description, tags_json,
                base_score, access_count,
                base_score + MIN(access_count, 20), created_at, updated_at
         FROM memory_entities WHERE project_id = ? AND entity_id IN ({placeholders})"
    );
    let mut values = Vec::with_capacity(entity_ids.len() + 1);
    values.push(project_id.to_string());
    values.extend(entity_ids.iter().cloned());
    let conn = database::connection();
    let mut stmt = conn.prepare(&sql)?;
    let entities = stmt
        .query_map(rusqlite::params_from_iter(values.iter()), row_to_entity)?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    let mut by_id = entities
        .into_iter()
        .map(|entity| (entity.entity_id.clone(), entity))
        .collect::<HashMap<_, _>>();
    Ok(entity_ids
        .iter()
        .filter_map(|entity_id| by_id.remove(entity_id))
        .collect())
}

pub fn get_entity_document(
    project_id: &str,
    entity_id: &str,
) -> Result<Option<MemoryEntityDocument>> {
    validate_path_segment(project_id, "project_id")?;
    validate_path_segment(entity_id, "entity_id")?;
    let Some(entity) = get_entity(project_id, entity_id)? else {
        return Ok(None);
    };
    let path = entity_absolute_path(project_id, &entity.file_path)?;
    let raw = fs::read_to_string(&path)?;
    let (_, body) = parse_memory_file(&raw, &path)?;
    Ok(Some(MemoryEntityDocument {
        entity,
        body: body.trim_start_matches('\n').to_string(),
    }))
}

pub fn list_entities(
    project_id: &str,
    query: Option<&str>,
    cursor: Option<&str>,
    limit: usize,
) -> Result<Page<MemoryEntity>> {
    let offset = parse_offset(cursor)?;
    let limit = limit.clamp(1, 100);
    let query = query.map(str::trim).filter(|value| !value.is_empty());
    let conn = database::connection();
    let select = "SELECT project_id, entity_id, file_path, title, description, tags_json,
                base_score, access_count, base_score + MIN(access_count, 20),
                created_at, updated_at
         FROM memory_entities";
    let order = " ORDER BY base_score + MIN(access_count, 20) DESC, updated_at DESC, entity_id ASC
         LIMIT ? OFFSET ?";
    let items = if let Some(query) = query {
        let pattern = format!(
            "%{}%",
            query
                .replace('\\', "\\\\")
                .replace('%', "\\%")
                .replace('_', "\\_")
        );
        let sql = format!(
            "{select} WHERE project_id = ?1
             AND (title LIKE ?2 ESCAPE '\\' OR description LIKE ?2 ESCAPE '\\'
                  OR tags_json LIKE ?2 ESCAPE '\\'){order}"
        );
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt
            .query_map(
                params![project_id, pattern, (limit + 1) as i64, offset as i64],
                row_to_entity,
            )?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        rows
    } else {
        let sql = format!("{select} WHERE project_id = ?1{order}");
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt
            .query_map(
                params![project_id, (limit + 1) as i64, offset as i64],
                row_to_entity,
            )?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        rows
    };
    page_from_extra(items, offset, limit)
}

/// Recall long-term Memory summaries without changing access counters.
///
/// Query matches the SQLite projection's title, description and tags. Tag
/// filters match structured Markdown tag key/value pairs exactly; all supplied
/// filters must match.
pub fn recall_entities(
    project_id: &str,
    query: Option<&str>,
    tags: &[MemoryTagFilter],
    cursor: Option<&str>,
    limit: usize,
) -> Result<Page<MemoryEntity>> {
    use rusqlite::types::Value;

    let offset = parse_offset(cursor)?;
    let limit = limit.clamp(1, 100);
    let query_patterns = query.and_then(text_query_patterns_json);
    let mut predicates = vec!["project_id = ?".to_string()];
    let mut values = Vec::new();

    if let Some(patterns) = query_patterns.as_ref() {
        values.push(Value::Text(patterns.clone()));
    }
    values.push(Value::Text(project_id.to_string()));

    for (index, tag) in tags.iter().enumerate() {
        let key = required(&tag.key, "tag.key")?;
        let alias = format!("memory_tag_{index}");
        let mut predicate = format!(
            "EXISTS (SELECT 1 FROM json_each(memory_entities.tags_json) AS {alias} \
             WHERE lower(json_extract({alias}.value, '$.key')) = lower(?)"
        );
        values.push(Value::Text(key));
        if let Some(value) = tag
            .value
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            predicate.push_str(&format!(
                " AND lower(json_extract({alias}.value, '$.value')) = lower(?)"
            ));
            values.push(Value::Text(value.to_string()));
        }
        predicate.push(')');
        predicates.push(predicate);
    }

    let sql = if query_patterns.is_some() {
        format!(
            "WITH query_terms(pattern) AS (SELECT value FROM json_each(?)),
             ranked_entities AS (
                SELECT project_id, entity_id, file_path, title, description, tags_json,
                       base_score, access_count, base_score + MIN(access_count, 20) AS score,
                       created_at, updated_at,
                       (SELECT COUNT(*) FROM query_terms
                        WHERE title LIKE pattern ESCAPE '\\'
                           OR description LIKE pattern ESCAPE '\\'
                           OR tags_json LIKE pattern ESCAPE '\\') AS query_hits,
                       (SELECT COUNT(*) FROM query_terms
                        WHERE title LIKE pattern ESCAPE '\\') AS title_hits,
                       (SELECT COUNT(*) FROM query_terms
                        WHERE tags_json LIKE pattern ESCAPE '\\') AS tag_hits
                FROM memory_entities
                WHERE {}
             )
             SELECT project_id, entity_id, file_path, title, description, tags_json,
                    base_score, access_count, score, created_at, updated_at
             FROM ranked_entities
             WHERE query_hits > 0
             ORDER BY query_hits DESC, title_hits DESC, tag_hits DESC,
                      score DESC, updated_at DESC, entity_id ASC
             LIMIT ? OFFSET ?",
            predicates.join(" AND ")
        )
    } else {
        format!(
            "SELECT project_id, entity_id, file_path, title, description, tags_json,
                    base_score, access_count, base_score + MIN(access_count, 20),
                    created_at, updated_at
             FROM memory_entities
             WHERE {}
             ORDER BY base_score + MIN(access_count, 20) DESC, updated_at DESC, entity_id ASC
             LIMIT ? OFFSET ?",
            predicates.join(" AND ")
        )
    };
    values.push(Value::Integer((limit + 1) as i64));
    values.push(Value::Integer(offset as i64));

    let conn = database::connection();
    let mut stmt = conn.prepare(&sql)?;
    let items = stmt
        .query_map(rusqlite::params_from_iter(values.iter()), row_to_entity)?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    page_from_extra(items, offset, limit)
}

pub fn list_relations(
    project_id: &str,
    entity_id: Option<&str>,
    limit: usize,
    offset: usize,
) -> Result<Vec<MemoryRelation>> {
    let conn = database::connection();
    let limit = limit.clamp(1, 100) as i64;
    let offset = offset as i64;
    let sql_all = "SELECT id, project_id, source_entity_id, target_entity_id, relation_type,
                description, base_score, access_count,
                base_score + MIN(access_count, 20), created_at, updated_at
         FROM memory_relations WHERE project_id = ?1
         ORDER BY base_score + MIN(access_count, 20) DESC, updated_at DESC, id ASC
         LIMIT ?2 OFFSET ?3";
    let sql_entity = "SELECT id, project_id, source_entity_id, target_entity_id, relation_type,
                description, base_score, access_count,
                base_score + MIN(access_count, 20), created_at, updated_at
         FROM memory_relations WHERE project_id = ?1
           AND (source_entity_id = ?2 OR target_entity_id = ?2)
         ORDER BY base_score + MIN(access_count, 20) DESC, updated_at DESC, id ASC
         LIMIT ?3 OFFSET ?4";
    let mut stmt = conn.prepare(if entity_id.is_some() {
        sql_entity
    } else {
        sql_all
    })?;
    let rows = if let Some(entity_id) = entity_id {
        stmt.query_map(
            params![project_id, entity_id, limit, offset],
            row_to_relation,
        )?
    } else {
        stmt.query_map(params![project_id, limit, offset], row_to_relation)?
    };
    Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
}

/// Return related Memory summaries without changing Entity or Relation access
/// counters. The caller records access only if it subsequently reads a full
/// Entity document through [`read_entity`].
pub fn list_related_memories(
    project_id: &str,
    entity_id: &str,
    cursor: Option<&str>,
    limit: usize,
) -> Result<Page<RelatedMemory>> {
    validate_path_segment(project_id, "project_id")?;
    validate_path_segment(entity_id, "entity_id")?;
    if get_entity(project_id, entity_id)?.is_none() {
        return Err(GroveError::not_found(format!("Memory Entity {entity_id}")));
    }
    let offset = parse_offset(cursor)?;
    let limit = limit.clamp(1, 100);
    let relations = list_relations(project_id, Some(entity_id), limit + 1, offset)?;
    let has_more = relations.len() > limit;
    let mut items = Vec::with_capacity(limit.min(relations.len()));
    for relation in relations.into_iter().take(limit) {
        let related_entity_id = if relation.source_entity_id == entity_id {
            &relation.target_entity_id
        } else {
            &relation.source_entity_id
        };
        if let Some(entity) = get_entity(project_id, related_entity_id)? {
            items.push(RelatedMemory { relation, entity });
        }
    }
    Ok(Page {
        items,
        next_cursor: has_more.then(|| (offset + limit).to_string()),
    })
}

/// Read one full Memory document and record the access atomically in SQLite.
///
/// Every successful document read increments the Entity. A supplied Relation
/// increments only when it exists in this Project and is incident to the read
/// Entity. Missing, stale or unrelated Relation ids are deliberately ignored
/// so they never block the document read.
pub fn read_entity(
    project_id: &str,
    entity_id: &str,
    via_relation_id: Option<&str>,
    related_limit: usize,
) -> Result<Option<MemoryReadResult>> {
    validate_path_segment(project_id, "project_id")?;
    validate_path_segment(entity_id, "entity_id")?;
    let Some(existing) = get_entity(project_id, entity_id)? else {
        return Ok(None);
    };
    let path = entity_absolute_path(project_id, &existing.file_path)?;
    let raw = fs::read_to_string(&path)?;
    let (_, body) = parse_memory_file(&raw, &path)?;
    let body = body.trim_start_matches('\n').to_string();

    let conn = database::connection();
    let tx = conn.unchecked_transaction()?;
    let updated = tx.execute(
        "UPDATE memory_entities SET access_count = access_count + 1
         WHERE project_id = ?1 AND entity_id = ?2",
        params![project_id, entity_id],
    )?;
    if updated == 0 {
        return Ok(None);
    }

    let relation_access_recorded = via_relation_id
        .map(str::trim)
        .filter(|relation_id| !relation_id.is_empty())
        .map(|relation_id| {
            tx.execute(
                "UPDATE memory_relations SET access_count = access_count + 1
                 WHERE project_id = ?1 AND id = ?2
                   AND (source_entity_id = ?3 OR target_entity_id = ?3)",
                params![project_id, relation_id, entity_id],
            )
            .map(|count| count > 0)
        })
        .transpose()?
        .unwrap_or(false);

    let entity = tx.query_row(
        "SELECT project_id, entity_id, file_path, title, description, tags_json,
                base_score, access_count, base_score + MIN(access_count, 20),
                created_at, updated_at
         FROM memory_entities WHERE project_id = ?1 AND entity_id = ?2",
        params![project_id, entity_id],
        row_to_entity,
    )?;

    let related_limit = related_limit.min(10);
    let mut related = Vec::with_capacity(related_limit);
    if related_limit > 0 {
        let mut stmt = tx.prepare(
            "SELECT id, project_id, source_entity_id, target_entity_id, relation_type,
                    description, base_score, access_count,
                    base_score + MIN(access_count, 20), created_at, updated_at
             FROM memory_relations WHERE project_id = ?1
               AND (source_entity_id = ?2 OR target_entity_id = ?2)
             ORDER BY base_score + MIN(access_count, 20) DESC, updated_at DESC, id ASC
             LIMIT ?3",
        )?;
        let relations = stmt
            .query_map(
                params![project_id, entity_id, related_limit as i64],
                row_to_relation,
            )?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        drop(stmt);
        for relation in relations {
            let related_entity_id = if relation.source_entity_id == entity_id {
                &relation.target_entity_id
            } else {
                &relation.source_entity_id
            };
            let related_entity = tx
                .query_row(
                    "SELECT project_id, entity_id, file_path, title, description, tags_json,
                            base_score, access_count, base_score + MIN(access_count, 20),
                            created_at, updated_at
                     FROM memory_entities WHERE project_id = ?1 AND entity_id = ?2",
                    params![project_id, related_entity_id],
                    row_to_entity,
                )
                .optional()?;
            if let Some(related_entity) = related_entity {
                related.push(RelatedMemory {
                    relation,
                    entity: related_entity,
                });
            }
        }
    }
    tx.commit()?;

    Ok(Some(MemoryReadResult {
        entity: MemoryEntityDocument { entity, body },
        related,
        relation_access_recorded,
    }))
}

pub fn apply_relation_operations(
    project_id: &str,
    operations: &[RelationOperation],
) -> Result<Vec<RelationOperationResult>> {
    validate_path_segment(project_id, "project_id")?;
    let conn = database::connection();
    let tx = conn.unchecked_transaction()?;
    let now = Utc::now().to_rfc3339();
    let mut results = Vec::with_capacity(operations.len());

    for operation in operations {
        match operation {
            RelationOperation::Upsert {
                id,
                source_entity_id,
                target_entity_id,
                relation_type,
                description,
                base_score,
            } => {
                validate_base_score(*base_score)?;
                if source_entity_id == target_entity_id {
                    return Err(GroveError::invalid_data("a Memory cannot relate to itself"));
                }
                for entity_id in [source_entity_id, target_entity_id] {
                    let exists: bool = tx.query_row(
                        "SELECT EXISTS(SELECT 1 FROM memory_entities
                         WHERE project_id = ?1 AND entity_id = ?2)",
                        params![project_id, entity_id],
                        |row| row.get(0),
                    )?;
                    if !exists {
                        return Err(GroveError::not_found(format!("Memory Entity {entity_id}")));
                    }
                }
                let relation_type = required(relation_type, "relation_type")?;
                let relation_id = id
                    .as_deref()
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(str::to_string)
                    .unwrap_or_else(|| format!("memory-relation-{}", Uuid::new_v4()));
                tx.execute(
                    "INSERT INTO memory_relations (
                        id, project_id, source_entity_id, target_entity_id, relation_type,
                        description, base_score, access_count, created_at, updated_at
                     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0, ?8, ?8)
                     ON CONFLICT(project_id, source_entity_id, target_entity_id, relation_type)
                     DO UPDATE SET description = excluded.description,
                                   base_score = excluded.base_score,
                                   updated_at = excluded.updated_at",
                    params![
                        relation_id,
                        project_id,
                        source_entity_id,
                        target_entity_id,
                        relation_type,
                        description.trim(),
                        base_score,
                        now,
                    ],
                )?;
                let relation = tx.query_row(
                    "SELECT id, project_id, source_entity_id, target_entity_id, relation_type,
                            description, base_score, access_count,
                            base_score + MIN(access_count, 20), created_at, updated_at
                     FROM memory_relations
                     WHERE project_id = ?1 AND source_entity_id = ?2
                       AND target_entity_id = ?3 AND relation_type = ?4",
                    params![
                        project_id,
                        source_entity_id,
                        target_entity_id,
                        relation_type
                    ],
                    row_to_relation,
                )?;
                results.push(RelationOperationResult::Upsert { relation });
            }
            RelationOperation::Delete { relation_id } => {
                let deleted = tx.execute(
                    "DELETE FROM memory_relations WHERE project_id = ?1 AND id = ?2",
                    params![project_id, relation_id],
                )? > 0;
                results.push(RelationOperationResult::Delete {
                    relation_id: relation_id.clone(),
                    deleted,
                });
            }
        }
    }
    tx.commit()?;
    Ok(results)
}

fn sync_entity_projections_on(
    tx: &rusqlite::Transaction<'_>,
    project_id: &str,
    base_scores: &HashMap<String, i64>,
) -> Result<ProjectionSyncResult> {
    for score in base_scores.values() {
        validate_base_score(*score)?;
    }
    let existing = list_all_entities_on(tx, project_id)?;
    let known_ids = existing
        .iter()
        .map(|(entity, _)| entity.entity_id.as_str())
        .collect::<HashSet<_>>();
    if let Some(unknown) = base_scores
        .keys()
        .find(|entity_id| !known_ids.contains(entity_id.as_str()))
    {
        return Err(GroveError::not_found(format!("Memory Entity {unknown}")));
    }
    let now = Utc::now().to_rfc3339();
    let mut updated = 0;
    let mut deleted = 0;
    for (entity, previous_hash) in existing {
        let path = entity_absolute_path(project_id, &entity.file_path)?;
        if !path.is_file() {
            tx.execute(
                "DELETE FROM memory_entities WHERE project_id = ?1 AND entity_id = ?2",
                params![project_id, entity.entity_id],
            )?;
            deleted += 1;
            continue;
        }
        let raw = fs::read_to_string(&path)?;
        let (frontmatter, _) = parse_memory_file(&raw, &path)?;
        let hash = content_hash(raw.as_bytes());
        let base_score = base_scores
            .get(&entity.entity_id)
            .copied()
            .unwrap_or(entity.base_score);
        let tags = normalize_memory_tags(&frontmatter.tags)?;
        let title = required(&frontmatter.title, "title")?;
        let description = required(&frontmatter.description, "description")?;
        if previous_hash == hash
            && entity.title == title
            && entity.description == description
            && entity.tags == tags
            && entity.base_score == base_score
        {
            continue;
        }
        let tags_json = serde_json::to_string(&tags)?;
        tx.execute(
            "UPDATE memory_entities
             SET title = ?1, description = ?2, tags_json = ?3, content_hash = ?4,
                 base_score = ?5, updated_at = ?6
             WHERE project_id = ?7 AND entity_id = ?8",
            params![
                title,
                description,
                tags_json,
                hash,
                base_score,
                now,
                project_id,
                entity.entity_id,
            ],
        )?;
        updated += 1;
    }
    Ok(ProjectionSyncResult { updated, deleted })
}

/// Capture the immutable business input for one claimed organization Run.
///
/// Logs use SQLite `rowid` as the exact boundary. A Log appended after this
/// query receives a larger rowid, remains invisible to this Run, and cannot be
/// deleted by its post action. Chat history keeps the durable time cursor
/// because it is append-only filesystem data rather than a managed DB queue.
pub fn prepare_organization_input(
    project_id: &str,
    automation_id: &str,
    trigger_payload: Option<&serde_json::Value>,
) -> Result<serde_json::Value> {
    validate_path_segment(project_id, "project_id")?;
    let config = get_project_config(project_id)?
        .ok_or_else(|| GroveError::invalid_data("Memory is not configured for this Project"))?;
    if !config.enabled || config.organization_automation_id != automation_id {
        return Err(GroveError::invalid_data(
            "Memory is disabled or linked to a different Automation",
        ));
    }
    let input_from_at = match config.last_input_through_at {
        Some(value) => Some(value),
        None => super::automations::latest_successful_input_through(automation_id)?,
    };
    let conn = database::connection();
    let log_through_rowid: i64 = conn.query_row(
        "SELECT COALESCE(MAX(rowid), 0) FROM memory_logs WHERE project_id = ?1",
        params![project_id],
        |row| row.get(0),
    )?;
    ensure_entities_dir(project_id)?;
    fs::create_dir_all(runs_dir(project_id)?)?;
    Ok(serde_json::json!({
        "deep_organization": config.deep_organization,
        "input_from_at": input_from_at,
        "input_through_at": Utc::now().to_rfc3339(),
        "log_through_rowid": log_through_rowid,
        "trigger": trigger_payload,
    }))
}

/// Scheduled organization only needs an Agent when its immutable input window
/// contains evidence. Manual and event triggers intentionally bypass this
/// check in the handler so users can still request a full review explicitly.
pub fn organization_has_pending_input(project_id: &str, automation_id: &str) -> Result<bool> {
    let input = prepare_organization_input(project_id, automation_id, None)?;
    let has_logs = input
        .get("log_through_rowid")
        .and_then(serde_json::Value::as_i64)
        .unwrap_or(0)
        > 0;
    if has_logs {
        return Ok(true);
    }
    if !input
        .get("deep_organization")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false)
    {
        return Ok(false);
    }
    let input_from_at = input
        .get("input_from_at")
        .and_then(serde_json::Value::as_str);
    let input_through_at = input
        .get("input_through_at")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| GroveError::invalid_data("Memory input has no input_through_at"))?;
    Ok(
        !list_recent_chat_files(project_id, input_from_at, input_through_at, None, 1)?
            .items
            .is_empty(),
    )
}

/// Stage the Agent's final publication inside the active Run. The MCP handler
/// immediately commits this staged value and finishes the business Run; the
/// ordinary Chat Session has an independent lifecycle.
pub fn stage_organization_submission(
    project_id: &str,
    run_id: &str,
    base_scores: &HashMap<String, i64>,
    summary: &str,
) -> Result<bool> {
    validate_path_segment(project_id, "project_id")?;
    let summary = required(summary, "summary")?;
    for score in base_scores.values() {
        validate_base_score(*score)?;
    }
    let conn = database::connection();
    let tx = conn.unchecked_transaction()?;
    let found: Option<Option<String>> = tx
        .query_row(
            "SELECT r.result_json FROM automation_runs r
             JOIN automations a ON a.id = r.automation_id
             WHERE r.id = ?1 AND r.status = 'running' AND a.project = ?2
               AND a.handler_key = ?3",
            params![
                run_id,
                project_id,
                super::automations::MEMORY_ORGANIZATION_HANDLER
            ],
            |row| row.get(0),
        )
        .optional()?;
    let Some(raw) = found else {
        tx.commit()?;
        return Ok(false);
    };
    let mut result = raw
        .as_deref()
        .and_then(|value| serde_json::from_str::<serde_json::Value>(value).ok())
        .unwrap_or_else(|| serde_json::json!({}));
    let object = result
        .as_object_mut()
        .ok_or_else(|| GroveError::invalid_data("Automation result_json must be an object"))?;
    object.insert(
        "organization_submission".to_string(),
        serde_json::json!({
            "entity_base_scores": base_scores,
            "summary": summary,
        }),
    );
    tx.execute(
        "UPDATE automation_runs SET result_json = ?1
         WHERE id = ?2 AND status = 'running'",
        params![serde_json::to_string(&result)?, run_id],
    )?;
    tx.commit()?;
    Ok(true)
}

pub fn organization_submission_staged(project_id: &str, run_id: &str) -> Result<bool> {
    validate_path_segment(project_id, "project_id")?;
    let conn = database::connection();
    let raw: Option<String> = conn
        .query_row(
            "SELECT r.result_json FROM automation_runs r
             JOIN automations a ON a.id = r.automation_id
             WHERE r.id = ?1 AND r.status = 'running' AND a.project = ?2
               AND a.handler_key = ?3",
            params![
                run_id,
                project_id,
                super::automations::MEMORY_ORGANIZATION_HANDLER
            ],
            |row| row.get(0),
        )
        .optional()?
        .flatten();
    Ok(raw
        .as_deref()
        .and_then(|value| serde_json::from_str::<serde_json::Value>(value).ok())
        .and_then(|value| value.get("organization_submission").cloned())
        .is_some())
}

/// Memory post action. The Automation framework calls this inside the same
/// transaction that changes the Run from `running` to `success`.
pub fn commit_organization_on(
    tx: &rusqlite::Transaction<'_>,
    project_id: &str,
    run_id: &str,
) -> Result<serde_json::Value> {
    validate_path_segment(project_id, "project_id")?;
    let (run_project, handler_key, memory_enabled, input_json, result_json): (
        String,
        String,
        bool,
        String,
        Option<String>,
    ) = tx.query_row(
        "SELECT a.project, a.handler_key,
                EXISTS(
                    SELECT 1 FROM memory_project_configs c
                    WHERE c.project_id = a.project
                      AND c.organization_automation_id = a.id
                      AND c.enabled = 1
                ), r.input_json, r.result_json
         FROM automation_runs r
         JOIN automations a ON a.id = r.automation_id
         WHERE r.id = ?1",
        params![run_id],
        |row| {
            Ok((
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                row.get(4)?,
            ))
        },
    )?;
    if run_project != project_id
        || handler_key != super::automations::MEMORY_ORGANIZATION_HANDLER
        || !memory_enabled
    {
        return Err(GroveError::invalid_data(
            "Memory Organization Run is no longer active for this Project",
        ));
    }
    let mut result = result_json
        .as_deref()
        .and_then(|value| serde_json::from_str::<serde_json::Value>(value).ok())
        .unwrap_or_else(|| serde_json::json!({}));
    let submission = result
        .get("organization_submission")
        .cloned()
        .ok_or_else(|| {
            GroveError::invalid_data("Agent completed without memory_mark_organization_finished")
        })?;
    let summary = submission
        .get("summary")
        .and_then(|value| value.as_str())
        .ok_or_else(|| GroveError::invalid_data("organization summary is missing"))?;
    let summary = required(summary, "summary")?;
    let base_scores = serde_json::from_value::<HashMap<String, i64>>(
        submission
            .get("entity_base_scores")
            .cloned()
            .unwrap_or_else(|| serde_json::json!({})),
    )?;
    let input = serde_json::from_str::<serde_json::Value>(&input_json)
        .map_err(|_| GroveError::invalid_data("Memory Run input_json is invalid"))?;
    let log_through_rowid = input
        .get("log_through_rowid")
        .and_then(|value| value.as_i64())
        .ok_or_else(|| GroveError::invalid_data("Memory Run has no Log snapshot"))?;
    let input_through_at = input
        .get("input_through_at")
        .and_then(|value| value.as_str())
        .ok_or_else(|| GroveError::invalid_data("Memory Run has no input_through_at"))?;

    let sync = sync_entity_projections_on(tx, project_id, &base_scores)?;
    let logs_consumed = tx.execute(
        "DELETE FROM memory_logs WHERE project_id = ?1 AND rowid <= ?2",
        params![project_id, log_through_rowid],
    )?;
    tx.execute(
        "UPDATE memory_project_configs
         SET last_input_through_at = ?1, updated_at = ?2
         WHERE project_id = ?3",
        params![input_through_at, Utc::now().to_rfc3339(), project_id],
    )?;
    let object = result
        .as_object_mut()
        .ok_or_else(|| GroveError::invalid_data("Automation result_json must be an object"))?;
    object.remove("organization_submission");
    for (key, delta) in [
        ("entities_updated", sync.updated as i64),
        ("entities_deleted", sync.deleted as i64),
    ] {
        let current = object
            .get(key)
            .and_then(|value| value.as_i64())
            .unwrap_or(0);
        object.insert(key.to_string(), serde_json::json!(current + delta));
    }
    object.insert(
        "logs_consumed".to_string(),
        serde_json::json!(logs_consumed),
    );
    object.insert("summary".to_string(), serde_json::json!(summary));
    Ok(result)
}

pub fn get_project_config(project_id: &str) -> Result<Option<MemoryProjectConfig>> {
    let conn = database::connection();
    conn.query_row(
        "SELECT project_id, enabled, deep_organization,
                pending_log_threshold, organization_automation_id,
                last_input_through_at, created_at, updated_at
         FROM memory_project_configs WHERE project_id = ?1",
        params![project_id],
        row_to_config,
    )
    .optional()
    .map_err(Into::into)
}

/// Single source of truth for whether Working Agents may see and use Project
/// Memory. Missing configuration is intentionally treated as disabled.
pub fn project_memory_enabled(project_id: &str) -> Result<bool> {
    Ok(get_project_config(project_id)?
        .map(|config| config.enabled)
        .unwrap_or(false))
}

pub fn save_project_config_with_automation(
    config: &MemoryProjectConfig,
    automation: &super::automations::Automation,
) -> Result<()> {
    let conn = database::connection();
    let tx = conn.unchecked_transaction()?;
    save_project_config_with_automation_on(&tx, config, automation)?;
    tx.commit()?;
    Ok(())
}

pub(crate) fn save_project_config_with_automation_on(
    conn: &rusqlite::Connection,
    config: &MemoryProjectConfig,
    automation: &super::automations::Automation,
) -> Result<()> {
    validate_path_segment(&config.project_id, "project_id")?;
    if automation.id != config.organization_automation_id
        || automation.project != config.project_id
        || automation.handler_key != super::automations::MEMORY_ORGANIZATION_HANDLER
    {
        return Err(GroveError::invalid_data(
            "organization_automation_id must reference this Project's Memory handler",
        ));
    }
    let now = Utc::now().to_rfc3339();
    let created_at = if config.created_at.trim().is_empty() {
        now.as_str()
    } else {
        config.created_at.as_str()
    };
    let automation_exists: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM automations WHERE id = ?1)",
        params![automation.id],
        |row| row.get(0),
    )?;
    if automation_exists {
        super::automations::update_on(conn, automation)?;
    } else {
        super::automations::insert_on(conn, automation)?;
    }
    conn.execute(
        "INSERT INTO memory_project_configs (
            project_id, enabled, deep_organization, pending_log_threshold,
            organization_automation_id, last_input_through_at, created_at, updated_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
         ON CONFLICT(project_id) DO UPDATE SET
            enabled = excluded.enabled,
            deep_organization = excluded.deep_organization,
            pending_log_threshold = excluded.pending_log_threshold,
            organization_automation_id = excluded.organization_automation_id,
            updated_at = excluded.updated_at",
        params![
            config.project_id,
            config.enabled as i64,
            config.deep_organization as i64,
            config.pending_log_threshold.filter(|value| *value > 0),
            config.organization_automation_id,
            config.last_input_through_at,
            created_at,
            now,
        ],
    )?;
    Ok(())
}

pub fn add_run_counts(
    run_id: &str,
    entities_created: i64,
    entities_updated: i64,
    entities_deleted: i64,
    relations_changed: i64,
) -> Result<()> {
    let conn = database::connection();
    let tx = conn.unchecked_transaction()?;
    let raw: Option<Option<String>> = tx
        .query_row(
            "SELECT result_json FROM automation_runs
             WHERE id = ?1 AND status = 'running'",
            params![run_id],
            |row| row.get(0),
        )
        .optional()?;
    let Some(raw) = raw else {
        return Err(GroveError::invalid_data(
            "Memory Organization Run is not running",
        ));
    };
    let mut result = raw
        .as_deref()
        .and_then(|value| serde_json::from_str::<serde_json::Value>(value).ok())
        .unwrap_or_else(|| serde_json::json!({}));
    let object = result
        .as_object_mut()
        .ok_or_else(|| GroveError::invalid_data("Automation result_json must be an object"))?;
    for (key, delta) in [
        ("entities_created", entities_created),
        ("entities_updated", entities_updated),
        ("entities_deleted", entities_deleted),
        ("relations_changed", relations_changed),
    ] {
        let current = object
            .get(key)
            .and_then(|value| value.as_i64())
            .unwrap_or(0);
        object.insert(key.to_string(), serde_json::json!(current + delta));
    }
    tx.execute(
        "UPDATE automation_runs SET result_json = ?1 WHERE id = ?2 AND status = 'running'",
        params![serde_json::to_string(&result)?, run_id],
    )?;
    tx.commit()?;
    Ok(())
}

pub fn list_pending_logs(
    project_id: &str,
    through_rowid: i64,
    cursor: Option<&str>,
    limit: usize,
) -> Result<Page<MemoryLog>> {
    let offset = parse_offset(cursor)?;
    let limit = limit.clamp(1, 200);
    let conn = database::connection();
    let mut stmt = conn.prepare(
        "SELECT id, project_id, task_id, chat_id, agent, title, tags_json,
                description, created_at
         FROM memory_logs
         WHERE project_id = ?1 AND rowid <= ?2
         ORDER BY rowid ASC LIMIT ?3 OFFSET ?4",
    )?;
    let items = stmt
        .query_map(
            params![project_id, through_rowid, (limit + 1) as i64, offset as i64],
            row_to_log,
        )?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    page_from_extra(items, offset, limit)
}

pub fn list_logs(
    project_id: &str,
    query: Option<&str>,
    cursor: Option<&str>,
    limit: usize,
) -> Result<Page<MemoryLog>> {
    let offset = parse_offset(cursor)?;
    let limit = limit.clamp(1, 100);
    let query_patterns = query.and_then(text_query_patterns_json);
    let conn = database::connection();
    let select = "SELECT id, project_id, task_id, chat_id, agent, title, tags_json,
                description, created_at FROM memory_logs";
    let order = " ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?";
    let items = if let Some(patterns) = query_patterns {
        let sql = "WITH query_terms(pattern) AS (SELECT value FROM json_each(?2)),
                   ranked_logs AS (
                     SELECT id, project_id, task_id, chat_id, agent, title, tags_json,
                            description, created_at,
                            (SELECT COUNT(*) FROM query_terms
                             WHERE title LIKE pattern ESCAPE '\\'
                                OR description LIKE pattern ESCAPE '\\'
                                OR tags_json LIKE pattern ESCAPE '\\') AS query_hits,
                            (SELECT COUNT(*) FROM query_terms
                             WHERE title LIKE pattern ESCAPE '\\') AS title_hits,
                            (SELECT COUNT(*) FROM query_terms
                             WHERE tags_json LIKE pattern ESCAPE '\\') AS tag_hits
                     FROM memory_logs
                     WHERE project_id = ?1
                   )
                   SELECT id, project_id, task_id, chat_id, agent, title, tags_json,
                          description, created_at
                   FROM ranked_logs
                   WHERE query_hits > 0
                   ORDER BY query_hits DESC, title_hits DESC, tag_hits DESC,
                            created_at DESC, id DESC
                   LIMIT ?3 OFFSET ?4";
        let mut stmt = conn.prepare(sql)?;
        let rows = stmt
            .query_map(
                params![project_id, patterns, (limit + 1) as i64, offset as i64],
                row_to_log,
            )?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        rows
    } else {
        let sql = format!("{select} WHERE project_id = ?1{order}");
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt
            .query_map(
                params![project_id, (limit + 1) as i64, offset as i64],
                row_to_log,
            )?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        rows
    };
    page_from_extra(items, offset, limit)
}

/// Convert an Agent-provided concept query into distinct LIKE patterns.
///
/// Spaces and common list punctuation separate concepts. Punctuation inside a
/// concept (for example `human-in-the-loop`) remains searchable. A query with
/// no separators is kept as one concept, which also preserves CJK substrings.
fn text_query_patterns_json(query: &str) -> Option<String> {
    let mut seen = HashSet::new();
    let mut patterns = Vec::new();
    for raw in query.split(|character: char| {
        character.is_whitespace() || matches!(character, ',' | ';' | '，' | '；' | '、' | '|')
    }) {
        let term = raw.trim_matches(|character: char| {
            matches!(
                character,
                '"' | '\''
                    | '“'
                    | '”'
                    | '‘'
                    | '’'
                    | '('
                    | ')'
                    | '['
                    | ']'
                    | '{'
                    | '}'
                    | '<'
                    | '>'
                    | '.'
                    | ':'
                    | '!'
                    | '?'
                    | '！'
                    | '？'
            )
        });
        if term.is_empty() || !seen.insert(term.to_lowercase()) {
            continue;
        }
        patterns.push(format!(
            "%{}%",
            term.replace('\\', "\\\\")
                .replace('%', "\\%")
                .replace('_', "\\_")
        ));
    }
    if patterns.is_empty() {
        None
    } else {
        serde_json::to_string(&patterns).ok()
    }
}

/// Delete user-selected short-term logs without affecting newer or unrelated
/// observations. The project predicate is part of every delete so IDs cannot
/// cross project boundaries.
pub fn delete_logs(project_id: &str, log_ids: &[String]) -> Result<usize> {
    validate_path_segment(project_id, "project_id")?;
    let conn = database::connection();
    let tx = conn.unchecked_transaction()?;
    let mut deleted = 0;
    for log_id in log_ids {
        validate_path_segment(log_id, "log_id")?;
        deleted += tx.execute(
            "DELETE FROM memory_logs WHERE project_id = ?1 AND id = ?2",
            params![project_id, log_id],
        )?;
    }
    tx.commit()?;
    Ok(deleted)
}

pub fn get_overview(project_id: &str, automation_id: &str) -> Result<MemoryOverview> {
    let conn = database::connection();
    let entity_count = conn.query_row(
        "SELECT COUNT(*) FROM memory_entities WHERE project_id = ?1",
        params![project_id],
        |row| row.get(0),
    )?;
    let relation_count = conn.query_row(
        "SELECT COUNT(*) FROM memory_relations WHERE project_id = ?1",
        params![project_id],
        |row| row.get(0),
    )?;
    let log_count = conn.query_row(
        "SELECT COUNT(*) FROM memory_logs WHERE project_id = ?1",
        params![project_id],
        |row| row.get(0),
    )?;
    let (
        run_count,
        successful_run_count,
        failed_run_count,
        in_progress_run_count,
        waiting_run_count,
        active_run_count,
        last_organized_at,
    ) =
        conn.query_row(
            "SELECT COUNT(*),
                    COALESCE(SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END), 0),
                    COALESCE(SUM(CASE WHEN status IN ('failed', 'timeout', 'interrupted') THEN 1 ELSE 0 END), 0),
                    COALESCE(SUM(CASE WHEN status IN ('queued', 'running') THEN 1 ELSE 0 END), 0),
                    COALESCE(SUM(CASE WHEN status = 'waiting' THEN 1 ELSE 0 END), 0),
                    COALESCE(SUM(CASE WHEN status IN ('queued', 'running', 'waiting', 'cancelling') THEN 1 ELSE 0 END), 0),
                    MAX(CASE WHEN status = 'success' THEN completed_at END)
             FROM automation_runs WHERE automation_id = ?1",
            params![automation_id],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                    row.get(6)?,
                ))
            },
        )?;
    let (input_tokens, cached_input_tokens, output_tokens, total_tokens) = conn.query_row(
        "SELECT COALESCE(SUM(u.input_tokens), 0),
                COALESCE(SUM(u.cached_read_tokens), 0),
                COALESCE(SUM(u.output_tokens), 0),
                COALESCE(SUM(u.total_tokens), 0)
         FROM chat_token_usage u
         JOIN automation_runs r ON r.id = u.automation_run_id
         WHERE r.automation_id = ?1",
        params![automation_id],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
    )?;
    let mut stmt = conn.prepare(
        "SELECT COALESCE(u.cost_currency, 'unknown'), COALESCE(SUM(u.cost_amount), 0.0)
         FROM chat_token_usage u
         JOIN automation_runs r ON r.id = u.automation_run_id
         WHERE r.automation_id = ?1 AND u.cost_amount IS NOT NULL
         GROUP BY COALESCE(u.cost_currency, 'unknown')",
    )?;
    let cost_by_currency = stmt
        .query_map(params![automation_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, f64>(1)?))
        })?
        .collect::<std::result::Result<HashMap<_, _>, _>>()?;

    Ok(MemoryOverview {
        entity_count,
        relation_count,
        log_count,
        run_count,
        successful_run_count,
        failed_run_count,
        in_progress_run_count,
        waiting_run_count,
        active_run_count,
        last_organized_at,
        usage: MemoryUsageTotals {
            input_tokens,
            cached_input_tokens,
            output_tokens,
            total_tokens,
            cost_by_currency,
        },
    })
}

pub fn get_run_usage(run_id: &str) -> Result<MemoryUsageTotals> {
    let conn = database::connection();
    let (input_tokens, cached_input_tokens, output_tokens, total_tokens) = conn.query_row(
        "SELECT COALESCE(SUM(input_tokens), 0),
                COALESCE(SUM(cached_read_tokens), 0),
                COALESCE(SUM(output_tokens), 0),
                COALESCE(SUM(total_tokens), 0)
         FROM chat_token_usage WHERE automation_run_id = ?1",
        params![run_id],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
    )?;
    let mut stmt = conn.prepare(
        "SELECT COALESCE(cost_currency, 'unknown'), COALESCE(SUM(cost_amount), 0.0)
         FROM chat_token_usage
         WHERE automation_run_id = ?1 AND cost_amount IS NOT NULL
         GROUP BY COALESCE(cost_currency, 'unknown')",
    )?;
    let cost_by_currency = stmt
        .query_map(params![run_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, f64>(1)?))
        })?
        .collect::<std::result::Result<HashMap<_, _>, _>>()?;
    Ok(MemoryUsageTotals {
        input_tokens,
        cached_input_tokens,
        output_tokens,
        total_tokens,
        cost_by_currency,
    })
}

pub fn read_run_history(project_id: &str, run_id: &str) -> Result<Vec<serde_json::Value>> {
    validate_path_segment(project_id, "project_id")?;
    validate_path_segment(run_id, "run_id")?;
    let path = runs_dir(project_id)?.join(run_id).join("history.jsonl");
    if !path.is_file() {
        return Ok(Vec::new());
    }
    const MAX_BYTES: u64 = 2 * 1024 * 1024;
    let mut file = fs::File::open(path)?;
    let length = file.metadata()?.len();
    let start = length.saturating_sub(MAX_BYTES);
    file.seek(SeekFrom::Start(start))?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)?;
    let mut raw = String::from_utf8_lossy(&bytes).into_owned();
    if start > 0 {
        raw = raw
            .split_once('\n')
            .map(|(_, rest)| rest)
            .unwrap_or("")
            .to_string();
    }
    Ok(raw
        .lines()
        .filter_map(|line| serde_json::from_str::<serde_json::Value>(line).ok())
        .collect())
}

pub fn list_recent_chat_files(
    project_id: &str,
    from_at: Option<&str>,
    through_at: &str,
    cursor: Option<&str>,
    limit: usize,
) -> Result<Page<RecentChatFile>> {
    struct Candidate {
        task_id: String,
        chat_id: String,
        path: PathBuf,
        modified: chrono::DateTime<Utc>,
        task_name: String,
        session_name: String,
    }

    let offset = parse_offset(cursor)?;
    let limit = limit.clamp(1, 100);
    let from = parse_optional_time(from_at)?;
    let through = chrono::DateTime::parse_from_rfc3339(through_at)
        .map_err(|e| GroveError::invalid_data(format!("invalid input_through_at: {e}")))?
        .with_timezone(&Utc);
    let tasks_dir = super::grove_dir()
        .join("projects")
        .join(project_id)
        .join("tasks");
    let mut files = Vec::new();
    if tasks_dir.is_dir() {
        for task in fs::read_dir(tasks_dir)? {
            let task = task?;
            let task_id = task.file_name().to_string_lossy().into_owned();
            // Organization Run chats are stored in an ordinary TaskChat
            // namespace but are not project-task evidence for the next Run.
            if task_id == super::tasks::MEMORY_TASK_ID {
                continue;
            }
            let chats_dir = task.path().join("chats");
            if !chats_dir.is_dir() {
                continue;
            }
            let task_name = super::tasks::get_task(project_id, &task_id)?
                .or(super::tasks::get_archived_task(project_id, &task_id)?)
                .map(|task| task.name)
                .unwrap_or_else(|| "Untitled Task".to_string());
            let session_names = super::tasks::load_chat_sessions(project_id, &task_id)?
                .into_iter()
                .map(|session| (session.id, session.title))
                .collect::<HashMap<_, _>>();
            for chat in fs::read_dir(chats_dir)? {
                let chat = chat?;
                let chat_id = chat.file_name().to_string_lossy().into_owned();
                let path = chat.path().join("history.jsonl");
                if !path.is_file() {
                    continue;
                }
                let modified: chrono::DateTime<Utc> = fs::metadata(&path)?.modified()?.into();
                if from.is_some_and(|from| modified <= from) || modified > through {
                    continue;
                }
                files.push(Candidate {
                    task_id: task_id.clone(),
                    chat_id: chat_id.clone(),
                    path,
                    modified,
                    task_name: task_name.clone(),
                    session_name: session_names
                        .get(&chat_id)
                        .cloned()
                        .unwrap_or_else(|| "Untitled Session".to_string()),
                });
            }
        }
    }
    files.sort_by(|a, b| a.modified.cmp(&b.modified).then(a.path.cmp(&b.path)));
    let end = (offset + limit).min(files.len());
    let items = files
        .get(offset..end)
        .unwrap_or_default()
        .iter()
        .map(|candidate| {
            let (new_content_start_line, total_lines) =
                history_line_hint(&candidate.path, from.as_ref())?;
            let absolute_path =
                fs::canonicalize(&candidate.path).unwrap_or_else(|_| candidate.path.clone());
            Ok(RecentChatFile {
                task_id: candidate.task_id.clone(),
                chat_id: candidate.chat_id.clone(),
                path: absolute_path.to_string_lossy().into_owned(),
                modified_at: candidate.modified.to_rfc3339(),
                task_name: candidate.task_name.clone(),
                session_name: candidate.session_name.clone(),
                new_content_start_line,
                total_lines,
            })
        })
        .collect::<Result<Vec<_>>>()?;
    let next_cursor = (end < files.len()).then(|| end.to_string());
    Ok(Page { items, next_cursor })
}

fn history_line_hint(
    path: &Path,
    review_after: Option<&chrono::DateTime<Utc>>,
) -> Result<(usize, usize)> {
    let mut reader = std::io::BufReader::new(fs::File::open(path)?);
    let mut line = String::new();
    let mut total_lines = 0usize;
    let mut candidate_start_line = 1usize;
    let mut first_new_turn_line = review_after.is_none().then_some(1usize);

    loop {
        line.clear();
        if reader.read_line(&mut line)? == 0 {
            break;
        }
        total_lines += 1;
        if review_after.is_none() || !line.contains(r#""type":"complete""#) {
            continue;
        }
        let end_ts = serde_json::from_str::<serde_json::Value>(&line)
            .ok()
            .and_then(|event| event.get("end_ts").and_then(serde_json::Value::as_i64));
        match end_ts {
            Some(end_ts) if end_ts > review_after.expect("checked above").timestamp() => {
                first_new_turn_line.get_or_insert(candidate_start_line);
            }
            Some(_) => candidate_start_line = total_lines + 1,
            // Old histories may not have a timestamp. Keep the earlier
            // candidate so the hint remains conservative and loses no context.
            None => {}
        }
    }

    Ok((
        first_new_turn_line.unwrap_or(candidate_start_line),
        total_lines,
    ))
}

fn list_all_entities_on(
    conn: &rusqlite::Connection,
    project_id: &str,
) -> Result<Vec<(MemoryEntity, String)>> {
    let mut stmt = conn.prepare(
        "SELECT project_id, entity_id, file_path, title, description, tags_json,
                base_score, access_count, base_score + MIN(access_count, 20),
                created_at, updated_at, content_hash
         FROM memory_entities WHERE project_id = ?1 ORDER BY entity_id ASC",
    )?;
    let rows = stmt
        .query_map(params![project_id], |row| {
            Ok((row_to_entity(row)?, row.get(11)?))
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(rows)
}

fn row_to_entity(row: &rusqlite::Row<'_>) -> rusqlite::Result<MemoryEntity> {
    let tags_json: String = row.get(5)?;
    Ok(MemoryEntity {
        project_id: row.get(0)?,
        entity_id: row.get(1)?,
        file_path: row.get(2)?,
        title: row.get(3)?,
        description: row.get(4)?,
        tags: serde_json::from_str(&tags_json).unwrap_or_default(),
        base_score: row.get(6)?,
        access_count: row.get(7)?,
        score: row.get(8)?,
        created_at: row.get(9)?,
        updated_at: row.get(10)?,
    })
}

fn row_to_relation(row: &rusqlite::Row<'_>) -> rusqlite::Result<MemoryRelation> {
    Ok(MemoryRelation {
        id: row.get(0)?,
        project_id: row.get(1)?,
        source_entity_id: row.get(2)?,
        target_entity_id: row.get(3)?,
        relation_type: row.get(4)?,
        description: row.get(5)?,
        base_score: row.get(6)?,
        access_count: row.get(7)?,
        score: row.get(8)?,
        created_at: row.get(9)?,
        updated_at: row.get(10)?,
    })
}

fn row_to_log(row: &rusqlite::Row<'_>) -> rusqlite::Result<MemoryLog> {
    let tags_json: String = row.get(6)?;
    Ok(MemoryLog {
        id: row.get(0)?,
        project_id: row.get(1)?,
        task_id: row.get(2)?,
        chat_id: row.get(3)?,
        agent: row.get(4)?,
        title: row.get(5)?,
        tags: serde_json::from_str(&tags_json).unwrap_or_default(),
        description: row.get(7)?,
        created_at: row.get(8)?,
    })
}

fn row_to_config(row: &rusqlite::Row<'_>) -> rusqlite::Result<MemoryProjectConfig> {
    Ok(MemoryProjectConfig {
        project_id: row.get(0)?,
        enabled: row.get::<_, i64>(1)? != 0,
        deep_organization: row.get::<_, i64>(2)? != 0,
        pending_log_threshold: row.get(3)?,
        organization_automation_id: row.get(4)?,
        last_input_through_at: row.get(5)?,
        created_at: row.get(6)?,
        updated_at: row.get(7)?,
    })
}

fn render_markdown(frontmatter: &MemoryFrontmatter) -> Result<String> {
    let yaml = serde_yaml::to_string(frontmatter)
        .map_err(|e| GroveError::invalid_data(format!("serialize Memory frontmatter: {e}")))?;
    Ok(format!("---\n{}---\n\n", yaml))
}

fn parse_markdown(raw: &str) -> Result<(MemoryFrontmatter, &str)> {
    let rest = raw.strip_prefix("---\n").ok_or_else(|| {
        GroveError::invalid_data("Memory Markdown must start with YAML frontmatter")
    })?;
    let (yaml, body) = rest
        .split_once("\n---\n")
        .ok_or_else(|| GroveError::invalid_data("Memory Markdown frontmatter is not closed"))?;
    let mut frontmatter: MemoryFrontmatter = serde_yaml::from_str(yaml)
        .map_err(|e| GroveError::invalid_data(format!("parse Memory frontmatter: {e}")))?;
    frontmatter.title = required(&frontmatter.title, "title")?;
    frontmatter.description = required(&frontmatter.description, "description")?;
    frontmatter.tags = normalize_memory_tags(&frontmatter.tags)?;
    Ok((frontmatter, body))
}

fn parse_memory_file<'a>(
    raw: &'a str,
    path: &std::path::Path,
) -> Result<(MemoryFrontmatter, &'a str)> {
    parse_markdown(raw).map_err(|error| {
        GroveError::invalid_data(format!("Memory file {}: {error}", path.display()))
    })
}

fn normalize_memory_tags(tags: &[MemoryTag]) -> Result<Vec<MemoryTag>> {
    let mut seen = HashSet::new();
    let mut result = Vec::new();
    for tag in tags {
        let key = required(&tag.key, "tag.key")?;
        let value = required(&tag.value, "tag.value")?;
        let identity = format!("{}\0{}", key.to_lowercase(), value.to_lowercase());
        if seen.insert(identity) {
            result.push(MemoryTag {
                key,
                value,
                icon: tag
                    .icon
                    .as_deref()
                    .map(str::trim)
                    .filter(|icon| !icon.is_empty())
                    .map(str::to_string),
            });
        }
    }
    Ok(result)
}

fn validate_base_score(score: i64) -> Result<()> {
    if !(0..=80).contains(&score) {
        return Err(GroveError::invalid_data(
            "base_score must be an integer from 0 through 80 inclusive",
        ));
    }
    Ok(())
}

fn validate_path_segment(value: &str, field: &str) -> Result<()> {
    let value = required(value, field)?;
    if value == "." || value == ".." || value.contains('/') || value.contains('\\') {
        return Err(GroveError::invalid_data(format!("invalid {field}")));
    }
    Ok(())
}

fn entity_absolute_path(project_id: &str, file_path: &str) -> Result<PathBuf> {
    let name = file_path
        .strip_prefix("entities/")
        .ok_or_else(|| GroveError::invalid_data("Memory Entity path must be under entities/"))?;
    validate_path_segment(name, "file_path")?;
    Ok(entities_dir(project_id)?.join(name))
}

fn content_hash(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

fn atomic_write(path: &Path, contents: &[u8]) -> Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| GroveError::invalid_data("Memory file has no parent directory"))?;
    fs::create_dir_all(parent)?;
    let tmp = parent.join(format!(".memory-{}.tmp", Uuid::new_v4()));
    let result = (|| -> std::io::Result<()> {
        let mut file = fs::File::create(&tmp)?;
        file.write_all(contents)?;
        file.sync_all()?;
        fs::rename(&tmp, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result.map_err(Into::into)
}

fn parse_offset(cursor: Option<&str>) -> Result<usize> {
    cursor
        .filter(|cursor| !cursor.is_empty())
        .map(|cursor| {
            cursor
                .parse::<usize>()
                .map_err(|_| {
                    GroveError::invalid_data(
                        "cursor must be the opaque non-negative integer string returned by the previous page",
                    )
                })
        })
        .transpose()
        .map(|offset| offset.unwrap_or(0))
}

fn parse_optional_time(value: Option<&str>) -> Result<Option<chrono::DateTime<Utc>>> {
    value
        .filter(|value| !value.is_empty())
        .map(|value| {
            chrono::DateTime::parse_from_rfc3339(value)
                .map(|time| time.with_timezone(&Utc))
                .map_err(|e| GroveError::invalid_data(format!("invalid timestamp: {e}")))
        })
        .transpose()
}

fn page_from_extra<T>(mut items: Vec<T>, offset: usize, limit: usize) -> Result<Page<T>> {
    let has_more = items.len() > limit;
    if has_more {
        items.truncate(limit);
    }
    Ok(Page {
        items,
        next_cursor: has_more.then(|| (offset + limit).to_string()),
    })
}

fn required(value: &str, field: &str) -> Result<String> {
    let value = value.trim();
    if value.is_empty() {
        return Err(GroveError::invalid_data(format!(
            "{field} must not be empty"
        )));
    }
    Ok(value.to_string())
}

fn non_empty(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

fn normalize_tags(tags: &[String]) -> Vec<String> {
    let mut seen = HashSet::new();
    tags.iter()
        .filter_map(|tag| {
            let tag = tag.trim();
            if tag.is_empty() {
                return None;
            }
            let normalized = tag.to_lowercase();
            seen.insert(normalized).then(|| tag.to_string())
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn memory_frontmatter_quotes_colons_and_reports_the_invalid_file() {
        let frontmatter = MemoryFrontmatter {
            title: "Example".into(),
            description: "Contract: details".into(),
            tags: vec![],
        };
        let raw = render_markdown(&frontmatter).unwrap();
        let (parsed, _) = parse_markdown(&raw).unwrap();
        assert_eq!(parsed.description, frontmatter.description);

        let bad = "---\ntitle: Example\ndescription: Contract: details\ntags: []\n---\n";
        let error = parse_memory_file(bad, std::path::Path::new("entities/broken.md"))
            .unwrap_err()
            .to_string();
        assert!(error.contains("entities/broken.md"));
        assert!(error.contains("parse Memory frontmatter"));
    }

    #[test]
    fn metadata_update_serializes_values_preserves_body_and_rejects_invalid_files() {
        let _lock = database::test_lock().blocking_lock();
        let temp = tempfile::tempdir().unwrap();
        crate::storage::set_grove_dir_override(Some(temp.path().to_path_buf()));
        let created =
            create_entity("structured-metadata-test", "Original", "Old", &[], 25).unwrap();
        let path = PathBuf::from(&created.absolute_path);
        let original = fs::read_to_string(&path).unwrap();
        fs::write(&path, format!("{original}# Body\n\nKeep: this text.\n")).unwrap();
        update_entity_metadata(
            "structured-metadata-test",
            &created.entity.entity_id,
            None,
            Some("Contract: details and # signs"),
            None,
        )
        .unwrap();
        let updated = fs::read_to_string(&path).unwrap();
        let (header, body) = parse_markdown(&updated).unwrap();
        assert_eq!(header.title, "Original");
        assert_eq!(header.description, "Contract: details and # signs");
        assert_eq!(body, "\n# Body\n\nKeep: this text.\n");

        let invalid =
            "---\ntitle: Original\ndescription: Invalid: unquoted\ntags: []\n---\n\n# Body\n";
        fs::write(&path, invalid).unwrap();
        assert!(update_entity_metadata(
            "structured-metadata-test",
            &created.entity.entity_id,
            Some("New"),
            None,
            None
        )
        .is_err());
        assert_eq!(fs::read_to_string(path).unwrap(), invalid);
        crate::storage::set_grove_dir_override(None);
    }

    fn insert_test_memory_config(project_id: &str, automation_id: &str, deep: bool) {
        let now = Utc::now().to_rfc3339();
        let timestamp = Utc::now().timestamp();
        let automation = crate::storage::automations::Automation {
            id: automation_id.to_string(),
            project: project_id.to_string(),
            name: "Memory organization".to_string(),
            enabled: true,
            handler_key: crate::storage::automations::MEMORY_ORGANIZATION_HANDLER.to_string(),
            agent_config: Default::default(),
            task_mode: crate::storage::automations::TargetMode::New,
            task_id: None,
            task_template: None,
            session_mode: crate::storage::automations::TargetMode::New,
            chat_id: None,
            session_template: None,
            prompt: "Organize Memory".to_string(),
            schedule_cron: "0 2 * * *".to_string(),
            event_triggers: Vec::new(),
            last_run_at: None,
            last_run_status: None,
            last_run_error: None,
            next_run_at: None,
            created_at: timestamp,
            updated_at: timestamp,
        };
        save_project_config_with_automation(
            &MemoryProjectConfig {
                project_id: project_id.to_string(),
                enabled: true,
                deep_organization: deep,
                pending_log_threshold: None,
                organization_automation_id: automation_id.to_string(),
                last_input_through_at: Some("2000-01-01T00:00:00Z".to_string()),
                created_at: now.clone(),
                updated_at: now,
            },
            &automation,
        )
        .unwrap();
    }

    #[test]
    fn scheduled_organization_requires_logs_when_deep_organization_is_off() {
        let _lock = database::test_lock().blocking_lock();
        let temp = tempfile::tempdir().unwrap();
        crate::storage::set_grove_dir_override(Some(temp.path().to_path_buf()));
        let project = "project-scheduled-memory";
        let automation = "automation-scheduled-memory";
        insert_test_memory_config(project, automation, false);

        assert!(!organization_has_pending_input(project, automation).unwrap());
        append_log(&NewMemoryLog {
            project_id: project,
            task_id: "task-1",
            chat_id: None,
            agent: Some("Codex"),
            title: "New decision",
            tags: &[],
            description: "A durable project decision was recorded.",
        })
        .unwrap();
        assert!(organization_has_pending_input(project, automation).unwrap());

        crate::storage::set_grove_dir_override(None);
    }

    #[test]
    fn deep_scheduled_organization_uses_new_task_chats_but_ignores_its_own_runs() {
        let _lock = database::test_lock().blocking_lock();
        let temp = tempfile::tempdir().unwrap();
        crate::storage::set_grove_dir_override(Some(temp.path().to_path_buf()));
        let project = "project-deep-scheduled-memory";
        let automation = "automation-deep-scheduled-memory";
        insert_test_memory_config(project, automation, true);

        let tasks_dir = temp.path().join("projects").join(project).join("tasks");
        let memory_history = tasks_dir
            .join(crate::storage::tasks::MEMORY_TASK_ID)
            .join("chats")
            .join("organization-chat")
            .join("history.jsonl");
        fs::create_dir_all(memory_history.parent().unwrap()).unwrap();
        fs::write(&memory_history, "{\"type\":\"complete\",\"end_ts\":1}\n").unwrap();
        assert!(!organization_has_pending_input(project, automation).unwrap());

        let task_history = tasks_dir
            .join("task-1")
            .join("chats")
            .join("chat-1")
            .join("history.jsonl");
        fs::create_dir_all(task_history.parent().unwrap()).unwrap();
        fs::write(&task_history, "{\"type\":\"complete\",\"end_ts\":1}\n").unwrap();
        assert!(organization_has_pending_input(project, automation).unwrap());

        crate::storage::set_grove_dir_override(None);
    }

    #[test]
    fn resolve_entities_returns_requested_metadata_without_recording_reads() {
        let _lock = database::test_lock().blocking_lock();
        let temp = tempfile::tempdir().unwrap();
        crate::storage::set_grove_dir_override(Some(temp.path().to_path_buf()));

        let first = create_entity(
            "project-resolve-memory",
            "First memory",
            "First summary",
            &[MemoryTag {
                key: "topic".to_string(),
                value: "architecture".to_string(),
                icon: None,
            }],
            50,
        )
        .unwrap()
        .entity;
        let second = create_entity(
            "project-resolve-memory",
            "Second memory",
            "Second summary",
            &[],
            40,
        )
        .unwrap()
        .entity;

        let resolved = resolve_entities(
            "project-resolve-memory",
            &[
                second.entity_id.clone(),
                "memory-missing".to_string(),
                first.entity_id.clone(),
            ],
        )
        .unwrap();

        assert_eq!(
            resolved
                .iter()
                .map(|entity| entity.title.as_str())
                .collect::<Vec<_>>(),
            vec!["Second memory", "First memory"]
        );
        assert_eq!(resolved[1].tags[0].value, "architecture");
        assert_eq!(resolved[0].access_count, 0);
        assert_eq!(resolved[1].access_count, 0);

        crate::storage::set_grove_dir_override(None);
    }

    #[test]
    fn organization_submission_only_finishes_after_mark_finished_is_staged() {
        let _lock = database::test_lock().blocking_lock();
        let temp = tempfile::tempdir().unwrap();
        crate::storage::set_grove_dir_override(Some(temp.path().to_path_buf()));

        let project = format!("project-{}", Uuid::new_v4().simple());
        let automation_id = format!("auto-{}", Uuid::new_v4().simple());
        let now = Utc::now().timestamp();
        let agent_config = crate::agent_config::AgentConfigSelection::default();
        let automation = crate::storage::automations::Automation {
            id: automation_id.clone(),
            project: project.clone(),
            name: "Memory organization".to_string(),
            enabled: true,
            handler_key: crate::storage::automations::MEMORY_ORGANIZATION_HANDLER.to_string(),
            agent_config: agent_config.clone(),
            task_mode: crate::storage::automations::TargetMode::New,
            task_id: None,
            task_template: None,
            session_mode: crate::storage::automations::TargetMode::New,
            chat_id: None,
            session_template: None,
            prompt: "Organize Memory".to_string(),
            schedule_cron: "0 2 * * *".to_string(),
            event_triggers: Vec::new(),
            last_run_at: None,
            last_run_status: None,
            last_run_error: None,
            next_run_at: None,
            created_at: now,
            updated_at: now,
        };
        crate::storage::automations::insert(&automation).unwrap();
        let run_id = match crate::storage::automations::claim_run(
            &automation_id,
            "manual",
            None,
            &automation.prompt,
            None,
            &agent_config,
            &serde_json::json!({}),
            "project_run",
            now,
            true,
        )
        .unwrap()
        {
            crate::storage::automations::RunClaim::Created(run_id) => run_id,
            crate::storage::automations::RunClaim::Existing(_) => {
                panic!("unexpected existing run")
            }
        };
        crate::storage::automations::mark_run_running(&run_id).unwrap();

        assert!(!organization_submission_staged(&project, &run_id).unwrap());
        assert!(
            stage_organization_submission(&project, &run_id, &HashMap::new(), "Finished").unwrap()
        );
        assert!(organization_submission_staged(&project, &run_id).unwrap());

        crate::storage::set_grove_dir_override(None);
    }

    #[test]
    fn append_log_persists_normalized_record() {
        let _lock = database::test_lock().blocking_lock();
        let temp = tempfile::tempdir().unwrap();
        crate::storage::set_grove_dir_override(Some(temp.path().to_path_buf()));

        let tags = vec![
            " Memory ".to_string(),
            "memory".to_string(),
            "Grove".to_string(),
            " ".to_string(),
        ];
        let log = append_log(&NewMemoryLog {
            project_id: "project-1",
            task_id: "task-1",
            chat_id: Some("chat-1"),
            agent: Some("Codex"),
            title: "  Memory design  ",
            tags: &tags,
            description: "  Append short-term memory  ",
        })
        .unwrap();

        assert_eq!(log.title, "Memory design");
        assert_eq!(log.description, "Append short-term memory");
        assert_eq!(log.tags, vec!["Memory", "Grove"]);

        let conn = database::connection();
        let stored: (String, String, String) = conn
            .query_row(
                "SELECT project_id, task_id, tags_json FROM memory_logs WHERE id = ?1",
                [&log.id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(stored.0, "project-1");
        assert_eq!(stored.1, "task-1");
        assert_eq!(stored.2, r#"["Memory","Grove"]"#);

        drop(conn);
        crate::storage::set_grove_dir_override(None);
    }

    #[test]
    fn recent_log_query_matches_terms_and_ranks_by_coverage() {
        let _lock = database::test_lock().blocking_lock();
        let temp = tempfile::tempdir().unwrap();
        crate::storage::set_grove_dir_override(Some(temp.path().to_path_buf()));

        append_log(&NewMemoryLog {
            project_id: "project-query-logs",
            task_id: "task-1",
            chat_id: None,
            agent: Some("Codex"),
            title: "API documentation structure",
            tags: &["typed".to_string()],
            description: "The SSE response contract is documented here.",
        })
        .unwrap();
        append_log(&NewMemoryLog {
            project_id: "project-query-logs",
            task_id: "task-2",
            chat_id: None,
            agent: Some("Codex"),
            title: "Session History",
            tags: &[],
            description: "Recent persistence notes.",
        })
        .unwrap();
        append_log(&NewMemoryLog {
            project_id: "project-query-logs",
            task_id: "task-3",
            chat_id: None,
            agent: Some("Codex"),
            title: "Unrelated observation",
            tags: &[],
            description: "No matching concepts.",
        })
        .unwrap();

        let page = list_logs(
            "project-query-logs",
            Some("API documentation structure typed SSE History"),
            None,
            10,
        )
        .unwrap();

        assert_eq!(page.items.len(), 2);
        assert_eq!(page.items[0].title, "API documentation structure");
        assert_eq!(page.items[1].title, "Session History");

        crate::storage::set_grove_dir_override(None);
    }

    #[test]
    fn recall_query_ranks_coverage_before_memory_score() {
        let _lock = database::test_lock().blocking_lock();
        let temp = tempfile::tempdir().unwrap();
        crate::storage::set_grove_dir_override(Some(temp.path().to_path_buf()));

        create_entity(
            "project-query-memory",
            "API documentation structure",
            "Defines typed SSE responses.",
            &[],
            10,
        )
        .unwrap();
        create_entity(
            "project-query-memory",
            "Session History",
            "Persistence notes.",
            &[],
            80,
        )
        .unwrap();

        let page = recall_entities(
            "project-query-memory",
            Some("API documentation structure typed SSE History"),
            &[],
            None,
            10,
        )
        .unwrap();

        assert_eq!(page.items.len(), 2);
        assert_eq!(page.items[0].title, "API documentation structure");
        assert_eq!(page.items[1].title, "Session History");

        crate::storage::set_grove_dir_override(None);
    }
}

//! Dedicated Grove Memory MCP server.
//!
//! It shares the existing loopback listener with `grove_agent`, but has its
//! own route, identity registry, `ServerHandler`, tool list and permissions.
//! Tokens are issued only to project-level Memory Organization Runs; callers
//! never supply trusted project or run identifiers as tool arguments.

use std::collections::HashMap;
use std::sync::{Arc, RwLock};

use axum::http::request::Parts;
use once_cell::sync::OnceCell;
use rmcp::handler::server::wrapper::Parameters;
use rmcp::schemars::JsonSchema;
use rmcp::transport::streamable_http_server::session::local::LocalSessionManager;
use rmcp::transport::streamable_http_server::{StreamableHttpServerConfig, StreamableHttpService};
use rmcp::{
    handler::server::tool::{Extension, ToolRouter},
    model::*,
    tool, tool_router, ErrorData as McpError, ServerHandler,
};
use serde::{Deserialize, Deserializer, Serialize};

use crate::error::GroveError;
use crate::storage::{automations, memory};

#[derive(Debug, Clone)]
struct CallerContext {
    project_id: String,
    run_id: String,
}

static TOKEN_MAP: OnceCell<Arc<RwLock<HashMap<String, CallerContext>>>> = OnceCell::new();

fn token_map() -> &'static Arc<RwLock<HashMap<String, CallerContext>>> {
    TOKEN_MAP.get_or_init(|| Arc::new(RwLock::new(HashMap::new())))
}

pub fn register_organization_token(
    token: impl Into<String>,
    project_id: impl Into<String>,
    run_id: impl Into<String>,
) {
    token_map().write().expect("token map poisoned").insert(
        token.into(),
        CallerContext {
            project_id: project_id.into(),
            run_id: run_id.into(),
        },
    );
}

pub fn unregister_token(token: &str) {
    token_map()
        .write()
        .expect("token map poisoned")
        .remove(token);
}

pub fn unregister_organization_run(project_id: &str, run_id: &str) {
    token_map()
        .write()
        .expect("token map poisoned")
        .retain(|_, caller| caller.project_id != project_id || caller.run_id != run_id);
}

pub fn build_mcp_url(token: &str) -> Option<String> {
    let port = super::agent_graph_mcp::listener_port()?;
    Some(format!("http://127.0.0.1:{port}/memory-mcp/{token}"))
}

#[derive(Clone)]
pub struct MemoryMcpService {
    tool_router: ToolRouter<Self>,
}

impl Default for MemoryMcpService {
    fn default() -> Self {
        Self {
            tool_router: Self::tool_router(),
        }
    }
}

impl MemoryMcpService {
    pub fn new() -> Self {
        Self::default()
    }
}

impl ServerHandler for MemoryMcpService {
    fn get_info(&self) -> ServerInfo {
        let mut info = ServerInfo::new(ServerCapabilities::builder().enable_tools().build());
        info.protocol_version = ProtocolVersion::LATEST;
        let mut implementation = Implementation::new("grove-memory", env!("CARGO_PKG_VERSION"));
        implementation.title = Some("Grove Memory MCP".to_string());
        implementation.website_url = Some("https://github.com/GarrickZ2/grove".to_string());
        info.server_info = implementation;
        info
    }

    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        context: rmcp::service::RequestContext<rmcp::RoleServer>,
    ) -> Result<CallToolResult, McpError> {
        let tcc = rmcp::handler::server::tool::ToolCallContext::new(self, request, context);
        self.tool_router.call(tcc).await
    }

    async fn list_tools(
        &self,
        _request: Option<PaginatedRequestParams>,
        context: rmcp::service::RequestContext<rmcp::RoleServer>,
    ) -> Result<ListToolsResult, McpError> {
        let parts = context.extensions.get::<Parts>().ok_or_else(|| {
            McpError::invalid_request("Memory MCP request context is missing".to_string(), None)
        })?;
        let caller = caller_from_parts(parts)?;
        let run = running_run(&caller.project_id, &caller.run_id)?;
        let mut tools = self.tool_router.list_all();
        tools.retain(|tool| ORGANIZATION_TOOLS.contains(&tool.name.as_ref()));
        if !deep_organization_enabled(&run) {
            tools.retain(|tool| tool.name != "memory_get_recent_chats");
        }
        Ok(ListToolsResult {
            tools,
            next_cursor: None,
            meta: None,
        })
    }
}

const ORGANIZATION_TOOLS: &[&str] = &[
    "memory_get_directory",
    "memory_create_entity",
    "memory_update_entity_metadata",
    "memory_delete_entity",
    "memory_get_pending_logs",
    "memory_get_recent_chats",
    "memory_get_relations",
    "memory_update_relations",
    "memory_mark_organization_finished",
];

#[tool_router]
impl MemoryMcpService {
    #[tool(
        name = "memory_get_directory",
        description = "Return the absolute path of this Project's managed long-term Memory directory. Read existing Markdown files and edit their bodies with filesystem tools, preserving frontmatter unchanged. Update titles, descriptions and tags only through memory_update_entity_metadata. Create and delete Entity files only through memory_create_entity and memory_delete_entity.",
        output_schema = rmcp::handler::server::tool::schema_for_type::<DirectoryOutput>()
    )]
    async fn get_directory(
        &self,
        Extension(parts): Extension<Parts>,
    ) -> Result<CallToolResult, McpError> {
        let (project_id, _) = organization_context(&parts)?;
        let path = memory::ensure_entities_dir(&project_id).map_err(storage_error)?;
        json_success(&DirectoryOutput {
            path: path.to_string_lossy().into_owned(),
        })
    }

    #[tool(
        name = "memory_create_entity",
        description = "Create and register one long-term Memory Entity, then return its managed Markdown path for body editing. Leave the YAML frontmatter unchanged; use memory_update_entity_metadata for later metadata changes. base_score is an integer from 0 through 80 inclusive. Tags are structured key/value objects; icon is optional per Tag and there is no Entity-level icon.",
        output_schema = rmcp::handler::server::tool::schema_for_type::<CreateEntityOutput>()
    )]
    async fn create_entity(
        &self,
        Parameters(input): Parameters<CreateEntityInput>,
        Extension(parts): Extension<Parts>,
    ) -> Result<CallToolResult, McpError> {
        let (project_id, run_id) = organization_context(&parts)?;
        let tags = input.tags.into_iter().map(Into::into).collect::<Vec<_>>();
        let entity = memory::create_entity(
            &project_id,
            &input.title,
            &input.description,
            &tags,
            input.base_score.get(),
        )
        .map_err(storage_error)?;
        memory::add_run_counts(&run_id, 1, 0, 0, 0).map_err(storage_error)?;
        json_success(&CreateEntityOutput {
            entity_id: entity.entity.entity_id,
            file_path: entity.absolute_path,
        })
    }

    #[tool(
        name = "memory_update_entity_metadata",
        description = "Update a Memory Entity's title, description, and/or tags using Grove's validated YAML serializer. Omitted fields remain unchanged; pass an empty tags array to clear tags. The Markdown body is preserved. The list/search projection updates when the organization Run is published. Do not directly edit YAML frontmatter.",
        output_schema = rmcp::handler::server::tool::schema_for_type::<UpdateEntityMetadataOutput>()
    )]
    async fn update_entity_metadata(
        &self,
        Parameters(input): Parameters<UpdateEntityMetadataInput>,
        Extension(parts): Extension<Parts>,
    ) -> Result<CallToolResult, McpError> {
        let (project_id, _) = organization_context(&parts)?;
        let tags = input
            .tags
            .map(|tags| tags.into_iter().map(Into::into).collect::<Vec<_>>());
        memory::update_entity_metadata(
            &project_id,
            &input.entity_id,
            input.title.as_deref(),
            input.description.as_deref(),
            tags.as_deref(),
        )
        .map_err(storage_error)?;
        json_success(&UpdateEntityMetadataOutput { updated: true })
    }

    #[tool(
        name = "memory_delete_entity",
        description = "Delete one managed long-term Memory Entity by entity_id. Grove removes its Markdown file, SQLite projection, and every Relation that references it. Returns deleted=false when the Entity does not exist.",
        output_schema = rmcp::handler::server::tool::schema_for_type::<DeleteEntityOutput>()
    )]
    async fn delete_entity(
        &self,
        Parameters(input): Parameters<EntityInput>,
        Extension(parts): Extension<Parts>,
    ) -> Result<CallToolResult, McpError> {
        let (project_id, run_id) = organization_context(&parts)?;
        let deleted =
            memory::delete_entity(&project_id, &input.entity_id).map_err(storage_error)?;
        if deleted {
            memory::add_run_counts(&run_id, 0, 0, 1, 0).map_err(storage_error)?;
        }
        json_success(&DeleteEntityOutput { deleted })
    }

    #[tool(
        name = "memory_get_pending_logs",
        description = "Page through append-only Memory Logs captured in this Run's fixed snapshot. Logs appended after the Run began are excluded and remain for the next Run. cursor is opaque; limit defaults to 100 and accepts 1 through 200.",
        output_schema = rmcp::handler::server::tool::schema_for_type::<memory::Page<MemoryLogItem>>()
    )]
    async fn get_pending_logs(
        &self,
        Parameters(input): Parameters<PendingLogsPageInput>,
        Extension(parts): Extension<Parts>,
    ) -> Result<CallToolResult, McpError> {
        let (project_id, run_id) = organization_context(&parts)?;
        let run = running_run(&project_id, &run_id)?;
        let log_through_rowid = run
            .input
            .get("log_through_rowid")
            .and_then(|value| value.as_i64())
            .ok_or_else(|| {
                McpError::internal_error(
                    "Grove could not load this Run's fixed Memory Log snapshot; cancel the Run and retry"
                        .to_string(),
                    None,
                )
            })?;
        let page = memory::list_pending_logs(
            &project_id,
            log_through_rowid,
            input.cursor.as_deref(),
            bounded_limit(input.limit, 100, 200, "limit")?,
        )
        .map_err(storage_error)?;
        json_success(&map_memory_page(page, MemoryLogItem::from))
    }

    #[tool(
        name = "memory_get_recent_chats",
        description = "List task chat-history files relevant to this Deep organization Run. Each item provides human-readable Task and Session names, an absolute JSONL path, a one-based suggested line where evidence since the previous successful organization begins, and the current total line count. Start at new_content_start_line for efficiency, but freely read earlier context and use rg, jq, sed, scripts, or other filesystem tools as appropriate. review_window explains the time range in plain language. cursor is opaque; limit defaults to 50 and accepts 1 through 100.",
        output_schema = rmcp::handler::server::tool::schema_for_type::<RecentChatsOutput>()
    )]
    async fn get_recent_chats(
        &self,
        Parameters(input): Parameters<RecentChatsPageInput>,
        Extension(parts): Extension<Parts>,
    ) -> Result<CallToolResult, McpError> {
        let (project_id, run_id) = organization_context(&parts)?;
        let run = running_run(&project_id, &run_id)?;
        if !deep_organization_enabled(&run) {
            return Err(McpError::invalid_request(
                "Recent Chats are not available because Deep organization is disabled for this Run"
                    .to_string(),
                None,
            ));
        }
        let input_from_at = run
            .input
            .get("input_from_at")
            .and_then(|value| value.as_str());
        let input_through_at = run
            .input
            .get("input_through_at")
            .and_then(|value| value.as_str())
            .ok_or_else(|| {
                McpError::internal_error(
                    "Grove could not load this Run's fixed Chat snapshot; cancel the Run and retry"
                        .to_string(),
                    None,
                )
            })?;
        let page = memory::list_recent_chat_files(
            &project_id,
            input_from_at,
            input_through_at,
            input.cursor.as_deref(),
            bounded_limit(input.limit, 50, 100, "limit")?,
        )
        .map_err(storage_error)?;
        json_success(&RecentChatsOutput {
            review_window: RecentChatsReviewWindow {
                mode: if input_from_at.is_some() {
                    "since_last_successful_organization".to_string()
                } else {
                    "all_history".to_string()
                },
                review_messages_after: input_from_at.map(ToOwned::to_owned),
                review_messages_until: input_through_at.to_string(),
            },
            items: page.items.into_iter().map(RecentChatItem::from).collect(),
            next_cursor: page.next_cursor,
        })
    }

    #[tool(
        name = "memory_get_relations",
        description = "Page through current Project Memory Relations, optionally filtering to Relations incident to one entity_id. Results are ordered by effective score and do not change access counts. cursor is opaque; limit defaults to 50 and accepts 1 through 100.",
        output_schema = rmcp::handler::server::tool::schema_for_type::<RelationPageOutput>()
    )]
    async fn get_relations(
        &self,
        Parameters(input): Parameters<GetRelationsInput>,
        Extension(parts): Extension<Parts>,
    ) -> Result<CallToolResult, McpError> {
        let (project_id, _) = organization_context(&parts)?;
        let offset = parse_cursor(input.cursor.as_deref())?;
        let limit = bounded_limit(input.limit, 50, 100, "limit")?;
        let relations =
            memory::list_relations(&project_id, input.entity_id.as_deref(), limit + 1, offset)
                .map_err(storage_error)?;
        let has_more = relations.len() > limit;
        let items = relations
            .into_iter()
            .take(limit)
            .map(OrganizationRelationItem::from)
            .collect::<Vec<_>>();
        json_success(&RelationPageOutput {
            items,
            next_cursor: has_more.then(|| (offset + limit).to_string()),
        })
    }

    #[tool(
        name = "memory_update_relations",
        description = "Atomically apply Relation changes as an array of JSON objects, never JSON-encoded strings. Each object uses op='upsert' or op='delete'. Upsert requires source_entity_id, target_entity_id, relation_type, and an integer base_score from 0 through 80; it preserves access_count and identifies an existing Relation by the same source, target, and type. To change those identity fields, delete the old Relation and upsert a new one. Delete requires relation_id.",
        output_schema = rmcp::handler::server::tool::schema_for_type::<UpdateRelationsOutput>()
    )]
    async fn update_relations(
        &self,
        Parameters(input): Parameters<UpdateRelationsInput>,
        Extension(parts): Extension<Parts>,
    ) -> Result<CallToolResult, McpError> {
        let (project_id, run_id) = organization_context(&parts)?;
        if input.operations.is_empty() {
            return Err(McpError::invalid_params(
                "operations must contain at least one Relation change object".to_string(),
                None,
            ));
        }
        let operations = input
            .operations
            .into_iter()
            .map(|change| match change {
                RelationChange::Upsert {
                    relation_id,
                    source_entity_id,
                    target_entity_id,
                    relation_type,
                    description,
                    base_score,
                } => memory::RelationOperation::Upsert {
                    id: relation_id,
                    source_entity_id,
                    target_entity_id,
                    relation_type,
                    description,
                    base_score: base_score.get(),
                },
                RelationChange::Delete { relation_id } => {
                    memory::RelationOperation::Delete { relation_id }
                }
            })
            .collect::<Vec<_>>();
        let results =
            memory::apply_relation_operations(&project_id, &operations).map_err(storage_error)?;
        let changed = results
            .iter()
            .filter(|result| match result {
                memory::RelationOperationResult::Upsert { .. } => true,
                memory::RelationOperationResult::Delete { deleted, .. } => *deleted,
            })
            .count();
        memory::add_run_counts(&run_id, 0, 0, 0, changed as i64).map_err(storage_error)?;
        json_success(&UpdateRelationsOutput { changed })
    }

    #[tool(
        name = "memory_mark_organization_finished",
        description = "Publish the final organization summary and the base score for each managed Entity, and finish the Memory Run. Every base_score must be an integer from 0 through 80 inclusive. Call exactly once after Entity and Relation work is complete. Finishing the Run does not end the underlying Chat Session.",
        output_schema = rmcp::handler::server::tool::schema_for_type::<FinishOutput>()
    )]
    async fn mark_finished(
        &self,
        Parameters(input): Parameters<FinishInput>,
        Extension(parts): Extension<Parts>,
    ) -> Result<CallToolResult, McpError> {
        let (project_id, run_id) = organization_context(&parts)?;
        if input.summary.trim().is_empty() {
            return Err(McpError::invalid_params(
                "summary is required".to_string(),
                None,
            ));
        }
        let mut scores = HashMap::with_capacity(input.entity_base_scores.len());
        for item in input.entity_base_scores {
            if scores
                .insert(item.entity_id.clone(), item.base_score.get())
                .is_some()
            {
                return Err(McpError::invalid_params(
                    format!(
                        "entity_base_scores contains duplicate entity_id '{}'",
                        item.entity_id
                    ),
                    None,
                ));
            }
        }
        let accepted = memory::stage_organization_submission(
            &project_id,
            &run_id,
            &scores,
            input.summary.trim(),
        )
        .map_err(storage_error)?;
        if !accepted {
            return Err(McpError::invalid_request(
                "Memory Organization Run is no longer running".to_string(),
                None,
            ));
        }
        let completed =
            automations::complete_consumer_run(&run_id, chrono::Utc::now().timestamp(), |tx| {
                let result = memory::commit_organization_on(tx, &project_id, &run_id)?;
                Ok(((), result))
            })
            .map_err(storage_error)?;
        if completed.is_none() {
            return Err(McpError::invalid_request(
                "Memory Organization Run is no longer running".to_string(),
                None,
            ));
        }
        let _ = memory::emit_pending_log_threshold_if_needed(&project_id);
        unregister_organization_run(&project_id, &run_id);
        json_success(&FinishOutput { staged: true })
    }
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct EntityInput {
    /// Managed Entity id returned by memory_create_entity or found in the Entity snapshot.
    #[schemars(length(min = 1))]
    entity_id: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct MemoryTagInput {
    /// Tag category, for example "topic", "component", or "workflow". Must be non-empty.
    #[schemars(length(min = 1))]
    key: String,
    /// Tag value inside the category. Must be non-empty.
    #[schemars(length(min = 1))]
    value: String,
    /// Optional presentation icon for this Tag only.
    icon: Option<String>,
}

impl From<MemoryTagInput> for memory::MemoryTag {
    fn from(value: MemoryTagInput) -> Self {
        Self {
            key: value.key,
            value: value.value,
            icon: value.icon,
        }
    }
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct CreateEntityInput {
    /// Concise document title. Must be non-empty after trimming.
    #[schemars(length(min = 1))]
    title: String,
    /// Summary used for list, search, hover, and recall before the Markdown body is read. Must be non-empty after trimming.
    #[schemars(length(min = 1))]
    description: String,
    /// Structured Markdown frontmatter tags. Use objects with key, value, and optional icon.
    #[serde(default)]
    tags: Vec<MemoryTagInput>,
    /// Initial importance score. Integer from 0 through 80 inclusive.
    base_score: BaseScore,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct UpdateEntityMetadataInput {
    /// Stable managed Entity id.
    entity_id: String,
    /// Replacement title, if changing it.
    title: Option<String>,
    /// Replacement description, if changing it.
    description: Option<String>,
    /// Replacement tags. An empty array removes all tags.
    tags: Option<Vec<MemoryTagInput>>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct PendingLogsPageInput {
    /// Opaque next_cursor returned by the previous memory_get_pending_logs call. Omit for the first page.
    cursor: Option<String>,
    /// Page size. Defaults to 100.
    #[schemars(range(min = 1, max = 200))]
    limit: Option<usize>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct RecentChatsPageInput {
    /// Opaque next_cursor returned by the previous memory_get_recent_chats call. Omit for the first page.
    cursor: Option<String>,
    /// Page size. Defaults to 50.
    #[schemars(range(min = 1, max = 100))]
    limit: Option<usize>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct GetRelationsInput {
    /// Optional Entity id. When present, returns only Relations connected to that Entity.
    #[schemars(length(min = 1))]
    entity_id: Option<String>,
    /// Opaque next_cursor returned by the previous memory_get_relations call. Omit for the first page.
    cursor: Option<String>,
    /// Page size. Defaults to 50.
    #[schemars(range(min = 1, max = 100))]
    limit: Option<usize>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct UpdateRelationsInput {
    /// Relation change objects. Each item must be an object with op="upsert" or op="delete", not a JSON string.
    #[schemars(length(min = 1))]
    operations: Vec<RelationChange>,
}

#[derive(Debug, JsonSchema)]
#[serde(tag = "op", rename_all = "snake_case", deny_unknown_fields)]
enum RelationChange {
    /// Create a Relation, or update one when relation_id is supplied.
    Upsert {
        /// Existing Relation id to update. Omit to create a new Relation.
        #[schemars(length(min = 1))]
        relation_id: Option<String>,
        /// Existing source Entity id.
        #[schemars(length(min = 1))]
        source_entity_id: String,
        /// Existing target Entity id. Must differ from source_entity_id.
        #[schemars(length(min = 1))]
        target_entity_id: String,
        /// Concise semantic relation name such as "supports", "constrains", or "depends_on".
        #[schemars(length(min = 1))]
        relation_type: String,
        /// Human-readable explanation of why the two Memories are related.
        #[serde(default)]
        description: String,
        /// Relation importance score. Integer from 0 through 80 inclusive.
        base_score: BaseScore,
    },
    /// Delete one Relation by id.
    Delete {
        /// Existing Relation id to delete.
        #[schemars(length(min = 1))]
        relation_id: String,
    },
}

#[derive(Debug, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case", deny_unknown_fields)]
enum RelationChangeWire {
    Upsert {
        relation_id: Option<String>,
        source_entity_id: String,
        target_entity_id: String,
        relation_type: String,
        #[serde(default)]
        description: String,
        base_score: BaseScore,
    },
    Delete {
        relation_id: String,
    },
}

impl From<RelationChangeWire> for RelationChange {
    fn from(value: RelationChangeWire) -> Self {
        match value {
            RelationChangeWire::Upsert {
                relation_id,
                source_entity_id,
                target_entity_id,
                relation_type,
                description,
                base_score,
            } => Self::Upsert {
                relation_id,
                source_entity_id,
                target_entity_id,
                relation_type,
                description,
                base_score,
            },
            RelationChangeWire::Delete { relation_id } => Self::Delete { relation_id },
        }
    }
}

impl<'de> Deserialize<'de> for RelationChange {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = serde_json::Value::deserialize(deserializer)?;
        if !value.is_object() {
            return Err(serde::de::Error::custom(
                "each operations item must be a JSON object, not a JSON-encoded string; allowed op values are 'upsert' and 'delete'",
            ));
        }
        serde_json::from_value::<RelationChangeWire>(value)
            .map(Into::into)
            .map_err(|error| {
                serde::de::Error::custom(format!(
                    "invalid Relation change object: {error}; allowed op values are 'upsert' and 'delete'"
                ))
            })
    }
}

#[derive(Debug, Clone, Copy, JsonSchema)]
#[serde(transparent)]
struct BaseScore(#[schemars(range(min = 0, max = 80))] i64);

impl BaseScore {
    fn get(self) -> i64 {
        self.0
    }
}

impl<'de> Deserialize<'de> for BaseScore {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let score = i64::deserialize(deserializer)?;
        if !(0..=80).contains(&score) {
            return Err(serde::de::Error::custom(
                "base_score must be an integer from 0 through 80 inclusive",
            ));
        }
        Ok(Self(score))
    }
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct EntityBaseScoreInput {
    /// Existing managed Entity id.
    #[schemars(length(min = 1))]
    entity_id: String,
    /// Final importance score. Integer from 0 through 80 inclusive.
    base_score: BaseScore,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct FinishInput {
    /// Final base scores for managed Entities. Omitted Entities keep their current base_score.
    #[serde(default)]
    entity_base_scores: Vec<EntityBaseScoreInput>,
    /// Concise human-readable summary of what this Run reviewed and changed. Must be non-empty after trimming.
    #[schemars(length(min = 1))]
    summary: String,
}

#[derive(Debug, Serialize, JsonSchema)]
struct DirectoryOutput {
    /// Absolute managed directory path.
    path: String,
}

#[derive(Debug, Serialize, JsonSchema)]
struct CreateEntityOutput {
    /// Stable id for later Relation or deletion operations.
    entity_id: String,
    /// Absolute Markdown path for body editing; do not directly edit frontmatter.
    file_path: String,
}

#[derive(Debug, Serialize, JsonSchema)]
struct UpdateEntityMetadataOutput {
    updated: bool,
}

#[derive(Debug, Serialize, JsonSchema)]
struct DeleteEntityOutput {
    /// Whether an Entity existed and was deleted.
    deleted: bool,
}

#[derive(Debug, Serialize, JsonSchema)]
struct MemoryLogItem {
    /// Concise short-term observation title.
    title: String,
    /// Flat topic labels supplied with the Log.
    tags: Vec<String>,
    /// Short-term observation details.
    description: String,
}

impl From<memory::MemoryLog> for MemoryLogItem {
    fn from(log: memory::MemoryLog) -> Self {
        Self {
            title: log.title,
            tags: log.tags,
            description: log.description,
        }
    }
}

#[derive(Debug, Serialize, JsonSchema)]
struct RecentChatItem {
    /// Human-readable Task name that provides the work context.
    task_name: String,
    /// Human-readable Session title that describes the conversation.
    session_name: String,
    /// Absolute JSONL history path, independent of the Agent working directory.
    absolute_history_path: String,
    /// One-based suggested line where evidence after the previous successful organization begins.
    new_content_start_line: usize,
    /// Current number of lines in the JSONL file.
    total_lines: usize,
}

impl From<memory::RecentChatFile> for RecentChatItem {
    fn from(chat: memory::RecentChatFile) -> Self {
        Self {
            task_name: chat.task_name,
            session_name: chat.session_name,
            absolute_history_path: chat.path,
            new_content_start_line: chat.new_content_start_line,
            total_lines: chat.total_lines,
        }
    }
}

#[derive(Debug, Serialize, JsonSchema)]
struct RecentChatsReviewWindow {
    /// all_history for the first Run; otherwise since_last_successful_organization.
    mode: String,
    /// Review messages after this time. Null means review all history.
    review_messages_after: Option<String>,
    /// This Run covers messages through this time.
    review_messages_until: String,
}

#[derive(Debug, Serialize, JsonSchema)]
struct RecentChatsOutput {
    /// Human-readable evidence window for this Run.
    review_window: RecentChatsReviewWindow,
    items: Vec<RecentChatItem>,
    #[serde(skip_serializing_if = "Option::is_none")]
    next_cursor: Option<String>,
}

#[derive(Debug, Serialize, JsonSchema)]
struct OrganizationRelationItem {
    /// Stable id for update or deletion.
    relation_id: String,
    /// Directed source Entity id.
    source_entity_id: String,
    /// Directed target Entity id.
    target_entity_id: String,
    /// Semantic Relation type.
    relation_type: String,
    /// Human-readable explanation of the connection.
    description: String,
    /// Current organizer-assigned importance from 0 through 80 inclusive.
    #[schemars(range(min = 0, max = 80))]
    base_score: i64,
}

impl From<memory::MemoryRelation> for OrganizationRelationItem {
    fn from(relation: memory::MemoryRelation) -> Self {
        Self {
            relation_id: relation.id,
            source_entity_id: relation.source_entity_id,
            target_entity_id: relation.target_entity_id,
            relation_type: relation.relation_type,
            description: relation.description,
            base_score: relation.base_score,
        }
    }
}

#[derive(Debug, Serialize, JsonSchema)]
struct RelationPageOutput {
    /// Relations in descending effective-score order, with only editable fields exposed.
    items: Vec<OrganizationRelationItem>,
    /// Opaque cursor for the next page; absent when there is no next page.
    #[serde(skip_serializing_if = "Option::is_none")]
    next_cursor: Option<String>,
}

#[derive(Debug, Serialize, JsonSchema)]
struct UpdateRelationsOutput {
    /// Number of Relations created, updated, or deleted.
    changed: usize,
}

#[derive(Debug, Serialize, JsonSchema)]
struct FinishOutput {
    /// True when Grove accepted and published the final Run submission.
    staged: bool,
}

fn map_memory_page<T, U>(page: memory::Page<T>, map: impl FnMut(T) -> U) -> memory::Page<U> {
    memory::Page {
        items: page.items.into_iter().map(map).collect(),
        next_cursor: page.next_cursor,
    }
}

fn caller_from_parts(parts: &Parts) -> Result<CallerContext, McpError> {
    let token = parts
        .uri
        .path()
        .trim_start_matches('/')
        .strip_prefix("memory-mcp/")
        .and_then(|rest| rest.split('/').next())
        .filter(|token| !token.is_empty())
        .ok_or_else(|| {
            McpError::invalid_request(
                "Memory MCP path must be /memory-mcp/<token>".to_string(),
                None,
            )
        })?;
    token_map()
        .read()
        .expect("token map poisoned")
        .get(token)
        .cloned()
        .ok_or_else(|| {
            McpError::invalid_request(
                "This Memory MCP Session is no longer valid; start a new Memory Organization Run"
                    .to_string(),
                None,
            )
        })
}

fn organization_context(parts: &Parts) -> Result<(String, String), McpError> {
    let caller = caller_from_parts(parts)?;
    validate_running_run(&caller.project_id, &caller.run_id)?;
    Ok((caller.project_id, caller.run_id))
}

fn running_run(project_id: &str, run_id: &str) -> Result<automations::AutomationRun, McpError> {
    let run = automations::get_run(run_id)
        .map_err(storage_error)?
        .ok_or_else(|| McpError::invalid_request("Memory Run does not exist".to_string(), None))?;
    let automation = automations::get(&run.automation_id)
        .map_err(storage_error)?
        .ok_or_else(|| McpError::invalid_request("Automation does not exist".to_string(), None))?;
    let config = memory::get_project_config(project_id)
        .map_err(storage_error)?
        .ok_or_else(|| McpError::invalid_request("Memory is not configured".to_string(), None))?;
    if automation.project != project_id
        || automation.handler_key != automations::MEMORY_ORGANIZATION_HANDLER
        || config.organization_automation_id != automation.id
        || !config.enabled
        || matches!(run.status.as_str(), "success" | "cancelled" | "cancelling")
    {
        return Err(McpError::invalid_request(
            "Memory Run is not running for this Project".to_string(),
            None,
        ));
    }
    Ok(run)
}

fn deep_organization_enabled(run: &automations::AutomationRun) -> bool {
    run.input
        .get("deep_organization")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false)
}

fn validate_running_run(project_id: &str, run_id: &str) -> Result<(), McpError> {
    running_run(project_id, run_id).map(|_| ())
}

fn storage_error(error: GroveError) -> McpError {
    match error {
        GroveError::InvalidData(message) => McpError::invalid_params(message, None),
        GroveError::NotFound(message) => McpError::invalid_request(message, None),
        other => McpError::internal_error(other.to_string(), None),
    }
}

fn json_error(error: serde_json::Error) -> McpError {
    McpError::internal_error(error.to_string(), None)
}

fn json_success<T: Serialize>(value: &T) -> Result<CallToolResult, McpError> {
    let value = serde_json::to_value(value).map_err(json_error)?;
    Ok(CallToolResult::structured(value))
}

fn parse_cursor(cursor: Option<&str>) -> Result<usize, McpError> {
    cursor
        .filter(|cursor| !cursor.is_empty())
        .map(|cursor| {
            cursor
                .parse::<usize>()
                .map_err(|_| {
                    McpError::invalid_params(
                        "cursor must be the opaque non-negative integer string returned by the previous page"
                            .to_string(),
                        None,
                    )
                })
        })
        .transpose()
        .map(|offset| offset.unwrap_or(0))
}

fn bounded_limit(
    value: Option<usize>,
    default: usize,
    max: usize,
    field: &str,
) -> Result<usize, McpError> {
    let value = value.unwrap_or(default);
    if !(1..=max).contains(&value) {
        return Err(McpError::invalid_params(
            format!("{field} must be an integer from 1 through {max} inclusive"),
            None,
        ));
    }
    Ok(value)
}

pub fn streamable_service() -> StreamableHttpService<MemoryMcpService, LocalSessionManager> {
    let session_manager = Arc::new(LocalSessionManager::default());
    let config = StreamableHttpServerConfig::default()
        .with_stateful_mode(true)
        .with_json_response(false);
    StreamableHttpService::new(|| Ok(MemoryMcpService::new()), session_manager, config)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn schema_fields(
        schema: &serde_json::Map<String, serde_json::Value>,
    ) -> std::collections::HashSet<String> {
        fn collect(value: &serde_json::Value, fields: &mut std::collections::HashSet<String>) {
            match value {
                serde_json::Value::Object(object) => {
                    if let Some(properties) =
                        object.get("properties").and_then(|value| value.as_object())
                    {
                        fields.extend(properties.keys().cloned());
                    }
                    for value in object.values() {
                        collect(value, fields);
                    }
                }
                serde_json::Value::Array(values) => {
                    for value in values {
                        collect(value, fields);
                    }
                }
                _ => {}
            }
        }

        let mut fields = std::collections::HashSet::new();
        collect(&serde_json::Value::Object(schema.clone()), &mut fields);
        fields
    }

    #[test]
    fn organization_tools_expose_complete_contracts() {
        let service = MemoryMcpService::new();
        let tools = service.tool_router.list_all();
        for name in ORGANIZATION_TOOLS {
            let tool = tools
                .iter()
                .find(|tool| tool.name == *name)
                .unwrap_or_else(|| panic!("missing tool {name}"));
            assert!(
                tool.description
                    .as_deref()
                    .is_some_and(|description| !description.trim().is_empty()),
                "{name} must have a description"
            );
            assert!(
                tool.output_schema.is_some(),
                "{name} must expose output_schema"
            );
        }

        let create = tools
            .iter()
            .find(|tool| tool.name == "memory_create_entity")
            .expect("create tool");
        let create_schema = serde_json::to_string(create.input_schema.as_ref()).expect("schema");
        assert!(create_schema.contains("\"minimum\":0"), "{create_schema}");
        assert!(create_schema.contains("\"maximum\":80"), "{create_schema}");

        let relations = tools
            .iter()
            .find(|tool| tool.name == "memory_update_relations")
            .expect("relations tool");
        let relation_schema =
            serde_json::to_string(relations.input_schema.as_ref()).expect("schema");
        assert!(
            relation_schema.contains("\"const\":\"upsert\""),
            "{relation_schema}"
        );
        assert!(
            relation_schema.contains("\"const\":\"delete\""),
            "{relation_schema}"
        );
        assert!(
            relation_schema.contains("\"minimum\":0"),
            "{relation_schema}"
        );
        assert!(
            relation_schema.contains("\"maximum\":80"),
            "{relation_schema}"
        );

        let create_output =
            serde_json::to_string(create.output_schema.as_ref().expect("output schema"))
                .expect("schema");
        let create_fields = schema_fields(create.output_schema.as_deref().expect("output schema"));
        for visible in ["entity_id", "file_path"] {
            assert!(create_fields.contains(visible), "{create_output}");
        }
        for hidden in [
            "project_id",
            "title",
            "description",
            "tags",
            "base_score",
            "access_count",
            "score",
            "created_at",
            "updated_at",
        ] {
            assert!(!create_fields.contains(hidden), "{create_output}");
        }

        let logs = tools
            .iter()
            .find(|tool| tool.name == "memory_get_pending_logs")
            .expect("logs tool");
        let logs_output =
            serde_json::to_string(logs.output_schema.as_ref().expect("output schema"))
                .expect("schema");
        let logs_fields = schema_fields(logs.output_schema.as_deref().expect("output schema"));
        for visible in ["title", "tags", "description"] {
            assert!(logs_fields.contains(visible), "{logs_output}");
        }
        for hidden in [
            "id",
            "project_id",
            "task_id",
            "chat_id",
            "agent",
            "created_at",
        ] {
            assert!(!logs_fields.contains(hidden), "{logs_output}");
        }

        let chats = tools
            .iter()
            .find(|tool| tool.name == "memory_get_recent_chats")
            .expect("chats tool");
        let chats_output =
            serde_json::to_string(chats.output_schema.as_ref().expect("output schema"))
                .expect("schema");
        let chats_fields = schema_fields(chats.output_schema.as_deref().expect("output schema"));
        for visible in [
            "review_window",
            "mode",
            "review_messages_after",
            "review_messages_until",
            "task_name",
            "session_name",
            "absolute_history_path",
            "new_content_start_line",
            "total_lines",
        ] {
            assert!(chats_fields.contains(visible), "{chats_output}");
        }
        for hidden in ["task_id", "chat_id", "agent_name", "modified_at"] {
            assert!(!chats_fields.contains(hidden), "{chats_output}");
        }

        let get_relations = tools
            .iter()
            .find(|tool| tool.name == "memory_get_relations")
            .expect("get relations tool");
        let get_relations_output =
            serde_json::to_string(get_relations.output_schema.as_ref().expect("output schema"))
                .expect("schema");
        let get_relations_fields = schema_fields(
            get_relations
                .output_schema
                .as_deref()
                .expect("output schema"),
        );
        for visible in [
            "relation_id",
            "source_entity_id",
            "target_entity_id",
            "relation_type",
            "description",
            "base_score",
        ] {
            assert!(
                get_relations_fields.contains(visible),
                "{get_relations_output}"
            );
        }
        for hidden in [
            "project_id",
            "access_count",
            "score",
            "created_at",
            "updated_at",
        ] {
            assert!(
                !get_relations_fields.contains(hidden),
                "{get_relations_output}"
            );
        }

        let relation_output =
            serde_json::to_string(relations.output_schema.as_ref().expect("output schema"))
                .expect("schema");
        let relation_fields =
            schema_fields(relations.output_schema.as_deref().expect("output schema"));
        assert!(relation_fields.contains("changed"), "{relation_output}");
        for hidden in [
            "project_id",
            "access_count",
            "score",
            "created_at",
            "updated_at",
        ] {
            assert!(!relation_fields.contains(hidden), "{relation_output}");
        }

        let finish = tools
            .iter()
            .find(|tool| tool.name == "memory_mark_organization_finished")
            .expect("finish tool");
        let finish_output =
            serde_json::to_string(finish.output_schema.as_ref().expect("output schema"))
                .expect("schema");
        let finish_fields = schema_fields(finish.output_schema.as_deref().expect("output schema"));
        assert!(finish_fields.contains("staged"), "{finish_output}");
        assert!(!finish_fields.contains("publication"), "{finish_output}");
    }

    #[test]
    fn relation_operations_reject_json_encoded_strings_with_actionable_error() {
        let error = serde_json::from_value::<UpdateRelationsInput>(serde_json::json!({
            "operations": ["{\"op\":\"upsert\"}"]
        }))
        .expect_err("string operation must fail")
        .to_string();
        assert!(error.contains("must be a JSON object"), "{error}");
        assert!(error.contains("upsert"), "{error}");
        assert!(error.contains("delete"), "{error}");
        assert!(!error.contains("RelationChange"), "{error}");
    }

    #[test]
    fn base_score_rejects_out_of_range_values_before_storage() {
        let error = serde_json::from_value::<CreateEntityInput>(serde_json::json!({
            "title": "A",
            "description": "B",
            "tags": [],
            "base_score": 81
        }))
        .expect_err("out-of-range score must fail")
        .to_string();
        assert_eq!(
            error,
            "base_score must be an integer from 0 through 80 inclusive"
        );
    }
}

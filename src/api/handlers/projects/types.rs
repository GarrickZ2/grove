//! Project DTOs (request/response types)

use serde::{Deserialize, Serialize};

/// Project list item (for GET /projects)
#[derive(Debug, Serialize)]
pub struct ProjectListItem {
    pub id: String,
    pub name: String,
    pub path: String,
    pub added_at: String,
    pub task_count: u32,
    pub live_count: u32,
    pub is_git_repo: bool,
    /// Whether the filesystem path still exists. When false, the project is
    /// considered "missing" — UI should show a warning state and only allow
    /// Delete (to clean up stale metadata).
    pub exists: bool,
    /// Project type: "repo" or "studio"
    pub project_type: String,
}

/// Project list response
#[derive(Debug, Serialize)]
pub struct ProjectListResponse {
    pub projects: Vec<ProjectListItem>,
    /// ID of the project matching the current working directory (if any)
    pub current_project_id: Option<String>,
}

/// Task response (matches frontend Task type)
#[derive(Debug, Serialize)]
pub struct TaskResponse {
    pub id: String,
    pub name: String,
    pub branch: String,
    pub target: String,
    pub status: String,
    pub additions: u32,
    pub deletions: u32,
    pub files_changed: u32,
    pub initial_commit: Option<String>,
    pub commits: Vec<CommitResponse>,
    pub created_at: String,
    pub updated_at: String,
    pub path: String,
    pub multiplexer: String,
    pub created_by: String,
    pub is_local: bool,
}

/// Commit response
#[derive(Debug, Serialize)]
pub struct CommitResponse {
    pub hash: String,
    pub message: String,
    pub time_ago: String,
}

/// Full project response (for GET /projects/{id})
#[derive(Debug, Serialize)]
pub struct ProjectResponse {
    pub id: String,
    pub name: String,
    pub path: String,
    pub current_branch: String,
    /// Worktree tasks only. Local Task is returned via `local_task`.
    pub tasks: Vec<TaskResponse>,
    /// The project's Local Task, with real session state.
    pub local_task: Option<TaskResponse>,
    pub added_at: String,
    pub is_git_repo: bool,
    /// Whether the filesystem path still exists.
    pub exists: bool,
    /// Project type: "repo" or "studio"
    pub project_type: String,
}

/// Rename project request
#[derive(Debug, Deserialize)]
pub struct RenameProjectRequest {
    pub name: String,
}

/// Add project request
#[derive(Debug, Deserialize)]
pub struct AddProjectRequest {
    pub path: String,
    pub name: Option<String>,
}

/// Create new project request
#[derive(Debug, Deserialize)]
pub struct NewProjectRequest {
    #[serde(default)]
    pub parent_dir: String,
    pub name: String,
    #[serde(default)]
    pub init_git: bool,
    /// Project type: "repo" (default) or "studio"
    #[serde(default)]
    pub project_type: Option<String>,
}

/// Clone remote git repository request
#[derive(Debug, Deserialize)]
pub struct CloneProjectRequest {
    pub url: String,
    /// Optional local directory name override (defaults to repo name from URL)
    pub name: Option<String>,
}

/// Project stats response
#[derive(Debug, Serialize)]
pub struct ProjectStatsResponse {
    pub total_tasks: u32,
    pub live_tasks: u32,
    pub idle_tasks: u32,
    pub merged_tasks: u32,
    pub archived_tasks: u32,
    /// Weekly activity (last 7 days, index 0 = today)
    pub weekly_activity: Vec<u32>,
}

/// Branch info response
#[derive(Debug, Serialize)]
pub struct BranchInfo {
    pub name: String,
    pub is_current: bool,
}

/// Branches list response
#[derive(Debug, Serialize)]
pub struct BranchesResponse {
    pub branches: Vec<BranchInfo>,
    pub current: String,
}

/// Resource file entry
#[derive(Debug, Serialize)]
pub struct ResourceFile {
    pub name: String,
    pub path: String,
    pub size: u64,
    pub modified_at: String,
    pub is_dir: bool,
}

/// Resource list response
#[derive(Debug, Serialize)]
pub struct ResourceListResponse {
    pub files: Vec<ResourceFile>,
}

/// Instructions response (also used for memory)
#[derive(Debug, Serialize)]
pub struct InstructionsResponse {
    pub content: String,
}

/// Instructions/memory update request
#[derive(Debug, Deserialize)]
pub struct InstructionsUpdateRequest {
    pub content: String,
}

/// Resource delete query
#[derive(Debug, Deserialize)]
pub struct ResourceDeleteQuery {
    pub path: String,
}

/// Resource file query
#[derive(Debug, Deserialize)]
pub struct ResourceFileQuery {
    pub path: String,
}

/// Query params for list resources (optional path for subdirectory listing)
#[derive(Debug, Deserialize)]
pub struct ResourceListQuery {
    pub path: Option<String>,
}

/// Query params for upload resource (optional path for subdirectory target)
#[derive(Debug, Deserialize)]
pub struct UploadQuery {
    pub path: Option<String>,
}

/// Create folder request
#[derive(Debug, Deserialize)]
pub struct CreateFolderRequest {
    pub path: String,
}

/// Move/rename resource request
#[derive(Debug, Deserialize)]
pub struct MoveResourceRequest {
    pub from: String,
    pub to: String,
    /// Overwrite destination if it already exists
    pub force: Option<bool>,
    /// Replace the final path component with this name
    pub rename_to: Option<String>,
}

/// Open command response
#[derive(Debug, Serialize)]
pub struct OpenResponse {
    pub success: bool,
    pub message: String,
}

/// Branch listing query params
#[derive(Debug, Deserialize)]
pub struct BranchQueryParams {
    /// Remote name: "local" (default), "origin", "upstream", etc.
    #[serde(default = "default_remote")]
    pub remote: String,
}

fn default_remote() -> String {
    "local".to_string()
}

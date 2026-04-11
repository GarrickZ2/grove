//! Task DTOs (request/response types)

use serde::{Deserialize, Serialize};

use super::super::projects::TaskResponse;

/// Task list query parameters
#[derive(Debug, Deserialize)]
pub struct TaskListQuery {
    pub filter: Option<String>, // "active" | "archived"
}

#[derive(Debug, Deserialize)]
pub struct ArchiveQuery {
    /// If true, skip safety checks and archive immediately.
    #[serde(default)]
    pub force: Option<bool>,
}

#[derive(Debug, Serialize)]
pub struct ArchiveConfirmResponse {
    pub error: String,
    pub code: String,
    pub task_name: String,
    pub branch: String,
    pub target: String,
    pub worktree_dirty: bool,
    pub branch_merged: bool,
    pub dirty_check_failed: bool,
    pub merge_check_failed: bool,
}

impl ArchiveConfirmResponse {
    /// Create an error response with default/safe values for status fields
    pub fn error(code: &str, error: &str, task_name: String) -> Self {
        Self {
            error: error.to_string(),
            code: code.to_string(),
            task_name,
            branch: String::new(),
            target: String::new(),
            worktree_dirty: false,
            // Default to merged to avoid false "not merged" warnings
            branch_merged: true,
            // Mark checks as failed to indicate we couldn't verify
            dirty_check_failed: true,
            merge_check_failed: true,
        }
    }

    /// Create a confirmation required response with actual check results
    pub fn confirm_required(
        task_name: String,
        branch: String,
        target: String,
        worktree_dirty: bool,
        branch_merged: bool,
        dirty_check_failed: bool,
        merge_check_failed: bool,
    ) -> Self {
        Self {
            error: "Archive requires confirmation".to_string(),
            code: "ARCHIVE_CONFIRM_REQUIRED".to_string(),
            task_name,
            branch,
            target,
            worktree_dirty,
            branch_merged,
            dirty_check_failed,
            merge_check_failed,
        }
    }
}

/// Task list response
#[derive(Debug, Serialize)]
pub struct TaskListResponse {
    pub tasks: Vec<TaskResponse>,
}

/// Create task request
#[derive(Debug, Deserialize)]
pub struct CreateTaskRequest {
    pub name: String,
    #[serde(default)]
    pub target: Option<String>,
    #[serde(default)]
    pub notes: Option<String>,
}

/// Notes response
#[derive(Debug, Serialize)]
pub struct NotesResponse {
    pub content: String,
}

/// Update notes request
#[derive(Debug, Deserialize)]
pub struct UpdateNotesRequest {
    pub content: String,
}

/// Commit request
#[derive(Debug, Deserialize)]
pub struct CommitRequest {
    pub message: String,
}

/// Merge request
#[derive(Debug, Deserialize)]
pub struct MergeRequest {
    /// Merge method: "squash" or "merge-commit" (default: auto-select based on commit count)
    #[serde(default)]
    pub method: Option<String>,
}

/// Rebase-to request (change target branch)
#[derive(Debug, Deserialize)]
pub struct RebaseToRequest {
    pub target: String,
}

/// Git operation response
#[derive(Debug, Serialize)]
pub struct GitOperationResponse {
    pub success: bool,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub warning: Option<String>,
}

/// Diff file entry
#[derive(Debug, Serialize)]
pub struct DiffFileEntry {
    pub path: String,
    pub status: String, // "A" | "M" | "D" | "R"
    pub additions: u32,
    pub deletions: u32,
}

/// Diff response
#[derive(Debug, Serialize)]
pub struct DiffResponse {
    pub files: Vec<DiffFileEntry>,
    pub total_additions: u32,
    pub total_deletions: u32,
}

/// Diff query parameters
#[derive(Debug, Deserialize)]
pub struct DiffQuery {
    /// When true, return full parsed diff with hunks and lines
    pub full: Option<bool>,
    /// Start ref (defaults to task.target)
    pub from_ref: Option<String>,
    /// End ref: commit hash or omit for working tree (latest)
    pub to_ref: Option<String>,
}

/// Commit entry for history
#[derive(Debug, Serialize)]
pub struct CommitEntry {
    pub hash: String,
    pub message: String,
    pub time_ago: String,
}

/// Commits response
#[derive(Debug, Serialize)]
pub struct CommitsResponse {
    pub commits: Vec<CommitEntry>,
    pub total: u32,
    /// Number of leading commits (newest-first) to skip when building version options.
    /// When working tree is clean: equals the count of consecutive commits whose tree
    /// matches HEAD's tree (at least 1, since commits[0] IS HEAD).
    /// When working tree is dirty: 0 (all commits become versions, Latest = working tree).
    pub skip_versions: u32,
}

/// Review comment reply entry
#[derive(Debug, Serialize)]
pub struct ReviewCommentReplyEntry {
    pub id: u32,
    pub content: String,
    pub author: String,
    pub timestamp: String,
}

/// Review comment entry
#[derive(Debug, Serialize)]
pub struct ReviewCommentEntry {
    pub id: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub comment_type: Option<String>, // "inline" | "file" | "project" (defaults to "inline")
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub side: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub start_line: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub end_line: Option<u32>,
    pub content: String,
    pub author: String,
    pub timestamp: String,
    pub status: String, // "open" | "resolved" | "outdated"
    pub replies: Vec<ReviewCommentReplyEntry>,
}

/// Review comments response
#[derive(Debug, Serialize)]
pub struct ReviewCommentsResponse {
    pub comments: Vec<ReviewCommentEntry>,
    pub open_count: u32,
    pub resolved_count: u32,
    pub outdated_count: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub git_user_name: Option<String>,
}

/// File list response
#[derive(serde::Serialize)]
pub struct FilesResponse {
    pub files: Vec<String>,
}

/// File content response
#[derive(Debug, Serialize)]
pub struct FileContentResponse {
    pub content: String,
    pub path: String,
}

/// Write file request
#[derive(Debug, Deserialize)]
pub struct WriteFileRequest {
    pub content: String,
}

/// File path query parameter
#[derive(Debug, Deserialize)]
pub struct FilePathQuery {
    pub path: String,
}

/// Reply to review comment request
#[derive(Debug, Deserialize)]
pub struct ReplyCommentRequest {
    pub comment_id: u32,
    pub message: String,
    pub author: Option<String>,
}

/// Update review comment status request
#[derive(Debug, Deserialize)]
pub struct UpdateCommentStatusRequest {
    pub status: String, // "open" | "resolved"
}

/// Edit comment content request
#[derive(Debug, Deserialize)]
pub struct EditCommentRequest {
    pub content: String,
}

/// Edit reply content request
#[derive(Debug, Deserialize)]
pub struct EditReplyRequest {
    pub content: String,
}

/// Bulk delete review comments request
#[derive(Debug, Deserialize)]
pub struct BulkDeleteRequest {
    /// Status filter (OR): ["resolved", "outdated", "open"]
    pub statuses: Option<Vec<String>>,
    /// Author filter (OR): ["Claude", "You"]
    pub authors: Option<Vec<String>>,
}

/// Create review comment request
#[derive(Debug, Deserialize)]
pub struct CreateReviewCommentRequest {
    pub content: String,
    /// Comment type: "inline" | "file" | "project" (defaults to "inline")
    pub comment_type: Option<String>,
    /// Structured fields
    pub file_path: Option<String>,
    pub side: Option<String>,
    pub start_line: Option<u32>,
    pub end_line: Option<u32>,
    pub author: Option<String>,
}

/// Create file request
#[derive(Debug, Deserialize)]
pub struct CreateFileRequest {
    pub path: String,
    #[serde(default)]
    pub content: Option<String>,
}

/// Create directory request
#[derive(Debug, Deserialize)]
pub struct CreateDirectoryRequest {
    pub path: String,
}

/// Delete file/directory request (via query param)
#[derive(Debug, Deserialize)]
pub struct DeletePathQuery {
    pub path: String,
}

/// Copy file request
#[derive(Debug, Deserialize)]
pub struct CopyFileRequest {
    pub source: String,
    pub destination: String,
}

/// File system operation response
#[derive(Debug, Serialize)]
pub struct FsOperationResponse {
    pub success: bool,
    pub message: String,
}

/// Artifact file entry
#[derive(Debug, Serialize)]
pub struct ArtifactFile {
    pub name: String,
    pub path: String,
    pub directory: String,
    pub size: u64,
    pub modified_at: String,
    pub is_dir: bool,
}

/// Artifacts response
#[derive(Debug, Serialize)]
pub struct ArtifactsResponse {
    pub input: Vec<ArtifactFile>,
    pub output: Vec<ArtifactFile>,
}

/// Artifact query parameters
#[derive(Debug, Deserialize)]
pub struct ArtifactQuery {
    pub path: String,
    pub dir: String,
}

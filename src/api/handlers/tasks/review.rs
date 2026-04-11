//! Task review comment handlers

use axum::{extract::Path, http::StatusCode, Json};

use crate::storage::{comments, tasks};

use super::crud::{find_project_by_id, get_git_user_name};
use super::types::*;

/// GET /api/v1/projects/{id}/tasks/{taskId}/review
pub async fn get_review_comments(
    Path((id, task_id)): Path<(String, String)>,
) -> Result<Json<ReviewCommentsResponse>, StatusCode> {
    let (_project, project_key) = find_project_by_id(&id)?;

    let mut data = comments::load_comments(&project_key, &task_id)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    if let Ok(Some(task)) = tasks::get_task(&project_key, &task_id) {
        let wt_path = task.worktree_path.clone();
        let target = task.target.clone();
        let changed = comments::apply_outdated_detection(&mut data, |file_path, side| {
            if side == "DELETE" {
                crate::git::show_file(&wt_path, &target, file_path).ok()
            } else {
                crate::git::read_file(&wt_path, file_path).ok()
            }
        });
        if changed {
            let _ = comments::save_comments(&project_key, &task_id, &data);
        }
    }

    let (open, resolved, outdated) = data.count_by_status();

    let comment_entries: Vec<ReviewCommentEntry> = data
        .comments
        .into_iter()
        .map(|c| {
            let status = match c.status {
                comments::CommentStatus::Open => "open",
                comments::CommentStatus::Resolved => "resolved",
                comments::CommentStatus::Outdated => "outdated",
            }
            .to_string();

            let replies = c
                .replies
                .into_iter()
                .map(|r| ReviewCommentReplyEntry {
                    id: r.id,
                    content: r.content,
                    author: r.author,
                    timestamp: r.timestamp,
                })
                .collect();

            ReviewCommentEntry {
                id: c.id,
                comment_type: Some(match c.comment_type {
                    comments::CommentType::Inline => "inline".to_string(),
                    comments::CommentType::File => "file".to_string(),
                    comments::CommentType::Project => "project".to_string(),
                }),
                file_path: c.file_path,
                side: c.side,
                start_line: c.start_line,
                end_line: c.end_line,
                content: c.content,
                author: c.author,
                timestamp: c.timestamp,
                status,
                replies,
            }
        })
        .collect();

    Ok(Json(ReviewCommentsResponse {
        comments: comment_entries,
        open_count: open as u32,
        resolved_count: resolved as u32,
        outdated_count: outdated as u32,
        git_user_name: get_git_user_name(&project_key, &task_id),
    }))
}

/// POST /api/v1/projects/{id}/tasks/{taskId}/review
pub async fn reply_review_comment(
    Path((id, task_id)): Path<(String, String)>,
    Json(req): Json<ReplyCommentRequest>,
) -> Result<Json<ReviewCommentsResponse>, StatusCode> {
    let (_project, project_key) = find_project_by_id(&id)?;

    let default_name = get_git_user_name(&project_key, &task_id);
    let author = req
        .author
        .as_deref()
        .or(default_name.as_deref())
        .unwrap_or("You");

    comments::reply_comment(&project_key, &task_id, req.comment_id, &req.message, author)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    get_review_comments(Path((id, task_id))).await
}

/// PUT /api/v1/projects/{id}/tasks/{taskId}/review/comments/{commentId}/status
pub async fn update_review_comment_status(
    Path((id, task_id, comment_id)): Path<(String, String, u32)>,
    Json(req): Json<UpdateCommentStatusRequest>,
) -> Result<Json<ReviewCommentsResponse>, StatusCode> {
    let (_project, project_key) = find_project_by_id(&id)?;

    let status = match req.status.as_str() {
        "open" => comments::CommentStatus::Open,
        "resolved" => comments::CommentStatus::Resolved,
        _ => return Err(StatusCode::BAD_REQUEST),
    };

    comments::update_comment_status(&project_key, &task_id, comment_id, status)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    get_review_comments(Path((id, task_id))).await
}

/// POST /api/v1/projects/{id}/tasks/{taskId}/review/comments
pub async fn create_review_comment(
    Path((id, task_id)): Path<(String, String)>,
    Json(req): Json<CreateReviewCommentRequest>,
) -> Result<Json<ReviewCommentsResponse>, StatusCode> {
    let (_project, project_key) = find_project_by_id(&id)?;

    let comment_type = match req.comment_type.as_deref() {
        Some("file") => comments::CommentType::File,
        Some("project") => comments::CommentType::Project,
        _ => comments::CommentType::Inline,
    };

    let default_name = get_git_user_name(&project_key, &task_id);
    let author = req
        .author
        .as_deref()
        .or(default_name.as_deref())
        .unwrap_or("You");

    match comment_type {
        comments::CommentType::Inline => {
            let (file_path, side, start_line, end_line) = if let Some(ref fp) = req.file_path {
                let side = req.side.as_deref().unwrap_or("ADD");
                let start = req.start_line.unwrap_or(1);
                let end = req.end_line.unwrap_or(start);
                (fp.clone(), side.to_string(), start, end)
            } else {
                return Err(StatusCode::BAD_REQUEST);
            };

            let anchor_text = tasks::get_task(&project_key, &task_id)
                .ok()
                .flatten()
                .and_then(|task| {
                    let content = if side == "DELETE" {
                        crate::git::show_file(&task.worktree_path, &task.target, &file_path).ok()
                    } else {
                        crate::git::read_file(&task.worktree_path, &file_path).ok()
                    };
                    content.and_then(|c| comments::extract_lines(&c, start_line, end_line))
                });

            comments::add_comment(
                &project_key,
                &task_id,
                comment_type,
                Some(file_path),
                Some(side),
                Some(start_line),
                Some(end_line),
                &req.content,
                author,
                anchor_text,
            )
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        }
        comments::CommentType::File => {
            let file_path = req.file_path.ok_or(StatusCode::BAD_REQUEST)?;

            comments::add_comment(
                &project_key,
                &task_id,
                comment_type,
                Some(file_path),
                None,
                None,
                None,
                &req.content,
                author,
                None,
            )
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        }
        comments::CommentType::Project => {
            comments::add_comment(
                &project_key,
                &task_id,
                comment_type,
                None,
                None,
                None,
                None,
                &req.content,
                author,
                None,
            )
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        }
    }

    get_review_comments(Path((id, task_id))).await
}

/// DELETE /api/v1/projects/{id}/tasks/{taskId}/review/comments/{commentId}
pub async fn delete_review_comment(
    Path((id, task_id, comment_id)): Path<(String, String, u32)>,
) -> Result<Json<ReviewCommentsResponse>, StatusCode> {
    let (_project, project_key) = find_project_by_id(&id)?;

    let deleted = comments::delete_comment(&project_key, &task_id, comment_id)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    if !deleted {
        return Err(StatusCode::NOT_FOUND);
    }

    get_review_comments(Path((id, task_id))).await
}

/// POST /api/v1/projects/{id}/tasks/{taskId}/review/bulk-delete
pub async fn bulk_delete_review_comments(
    Path((id, task_id)): Path<(String, String)>,
    Json(req): Json<BulkDeleteRequest>,
) -> Result<Json<ReviewCommentsResponse>, StatusCode> {
    let (_project, project_key) = find_project_by_id(&id)?;

    let raw_statuses = req.statuses.unwrap_or_default();
    let statuses: Vec<comments::CommentStatus> = raw_statuses
        .iter()
        .filter_map(|s| match s.to_lowercase().as_str() {
            "open" => Some(comments::CommentStatus::Open),
            "resolved" => Some(comments::CommentStatus::Resolved),
            "outdated" => Some(comments::CommentStatus::Outdated),
            _ => None,
        })
        .collect();

    if !raw_statuses.is_empty() && statuses.is_empty() {
        return Err(StatusCode::BAD_REQUEST);
    }

    let authors = req.authors.unwrap_or_default();

    comments::bulk_delete_comments(&project_key, &task_id, &statuses, &authors)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    get_review_comments(Path((id, task_id))).await
}

/// PUT /api/v1/projects/{id}/tasks/{taskId}/review/comments/{commentId}/content
pub async fn edit_review_comment(
    Path((id, task_id, comment_id)): Path<(String, String, u32)>,
    Json(req): Json<EditCommentRequest>,
) -> Result<Json<ReviewCommentsResponse>, StatusCode> {
    let (_project, project_key) = find_project_by_id(&id)?;

    let edited = comments::edit_comment(&project_key, &task_id, comment_id, &req.content)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    if !edited {
        return Err(StatusCode::NOT_FOUND);
    }

    get_review_comments(Path((id, task_id))).await
}

/// PUT /api/v1/projects/{id}/tasks/{taskId}/review/comments/{commentId}/replies/{replyId}
pub async fn edit_review_reply(
    Path((id, task_id, comment_id, reply_id)): Path<(String, String, u32, u32)>,
    Json(req): Json<EditReplyRequest>,
) -> Result<Json<ReviewCommentsResponse>, StatusCode> {
    let (_project, project_key) = find_project_by_id(&id)?;

    let edited = comments::edit_reply(&project_key, &task_id, comment_id, reply_id, &req.content)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    if !edited {
        return Err(StatusCode::NOT_FOUND);
    }

    get_review_comments(Path((id, task_id))).await
}

/// DELETE /api/v1/projects/{id}/tasks/{taskId}/review/comments/{commentId}/replies/{replyId}
pub async fn delete_review_reply(
    Path((id, task_id, comment_id, reply_id)): Path<(String, String, u32, u32)>,
) -> Result<Json<ReviewCommentsResponse>, StatusCode> {
    let (_project, project_key) = find_project_by_id(&id)?;

    let deleted = comments::delete_reply(&project_key, &task_id, comment_id, reply_id)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    if !deleted {
        return Err(StatusCode::NOT_FOUND);
    }

    get_review_comments(Path((id, task_id))).await
}

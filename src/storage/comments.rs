use std::collections::HashMap;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use super::ensure_project_dir;
use crate::error::Result;

/// Comment 状态
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum CommentStatus {
    /// 未处理
    #[default]
    Open,
    /// AI 回复并标记已解决
    Resolved,
    /// AI 回复但标记未解决（需要讨论/拒绝）
    NotResolved,
}

/// 单条 Review Comment
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Comment {
    /// 唯一序号
    pub id: u32,
    /// 位置（如 "src/main.rs:42" 或 "src/app.rs:100-105"）
    pub location: String,
    /// Comment 内容
    pub content: String,
    /// 状态
    #[serde(default)]
    pub status: CommentStatus,
    /// AI 回复
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reply: Option<String>,
}

/// Review Comments 数据
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct CommentsData {
    #[serde(default)]
    pub comments: Vec<Comment>,
}

impl CommentsData {
    pub fn is_empty(&self) -> bool {
        self.comments.is_empty()
    }

    /// 统计各状态的数量
    pub fn count_by_status(&self) -> (usize, usize, usize) {
        let mut open = 0;
        let mut resolved = 0;
        let mut not_resolved = 0;
        for c in &self.comments {
            match c.status {
                CommentStatus::Open => open += 1,
                CommentStatus::Resolved => resolved += 1,
                CommentStatus::NotResolved => not_resolved += 1,
            }
        }
        (open, resolved, not_resolved)
    }
}

/// AI 回复数据（按 location 索引）
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct ReplyData {
    pub status: CommentStatus,
    pub reply: String,
}

/// replies.json 存储格式
type RepliesMap = HashMap<String, ReplyData>;

/// 获取 replies.json 存储路径: ~/.grove/projects/{project}/ai/{task_id}/replies.json
fn replies_path(project: &str, task_id: &str) -> Result<PathBuf> {
    let dir = ensure_project_dir(project)?.join("ai").join(task_id);
    std::fs::create_dir_all(&dir)?;
    Ok(dir.join("replies.json"))
}

/// 获取 diff_comments.md 路径（difit 写入的源头数据）
fn diff_comments_path(project: &str, task_id: &str) -> Result<PathBuf> {
    let dir = ensure_project_dir(project)?.join("ai").join(task_id);
    std::fs::create_dir_all(&dir)?;
    Ok(dir.join("diff_comments.md"))
}

/// 从 diff_comments.md 解析 comments
///
/// difit 写入的格式:
/// ```
/// src/main.rs:L42
/// comment content here
/// maybe multiple lines
/// =====
/// src/app.rs:L100
/// another comment
/// ```
fn parse_diff_comments(content: &str) -> Vec<Comment> {
    let mut comments = Vec::new();
    let mut id = 1u32;

    // 按 "=====" 分隔符切分
    for block in content.split("\n=====\n") {
        let block = block.trim();
        if block.is_empty() {
            continue;
        }

        // 第一行是 location，剩余是 content
        let mut lines = block.lines();
        if let Some(location) = lines.next() {
            let location = location.trim().to_string();
            if location.is_empty() {
                continue;
            }

            let content: String = lines.collect::<Vec<_>>().join("\n").trim().to_string();
            if content.is_empty() {
                continue;
            }

            comments.push(Comment {
                id,
                location,
                content,
                status: CommentStatus::Open,
                reply: None,
            });
            id += 1;
        }
    }

    comments
}

/// 加载 AI 回复数据
fn load_replies(project: &str, task_id: &str) -> Result<RepliesMap> {
    let path = replies_path(project, task_id)?;
    if !path.exists() {
        return Ok(HashMap::new());
    }
    let content = std::fs::read_to_string(&path)?;
    let data = serde_json::from_str(&content)?;
    Ok(data)
}

/// 保存 AI 回复数据
fn save_replies(project: &str, task_id: &str, replies: &RepliesMap) -> Result<()> {
    let path = replies_path(project, task_id)?;
    let content = serde_json::to_string_pretty(replies)?;
    std::fs::write(&path, content)?;
    Ok(())
}

/// 读取 Review Comments
///
/// 策略：
/// 1. 从 diff_comments.md 读取 difit 写入的源头数据
/// 2. 从 replies.json 读取 AI 回复数据
/// 3. 合并两者（按 location 匹配）
pub fn load_comments(project: &str, task_id: &str) -> Result<CommentsData> {
    let diff_path = diff_comments_path(project, task_id)?;

    // 从 diff_comments.md 读取源头数据
    let mut comments = if diff_path.exists() {
        let content = std::fs::read_to_string(&diff_path)?;
        parse_diff_comments(&content)
    } else {
        Vec::new()
    };

    // 从 replies.json 读取 AI 回复，合并到 comments
    let replies = load_replies(project, task_id)?;
    for comment in &mut comments {
        if let Some(reply_data) = replies.get(&comment.location) {
            comment.status = reply_data.status;
            comment.reply = Some(reply_data.reply.clone());
        }
    }

    Ok(CommentsData { comments })
}

/// 回复 Comment 并更新状态
///
/// 只保存 AI 回复到 replies.json，不修改 diff_comments.md
pub fn reply_comment(
    project: &str,
    task_id: &str,
    comment_id: u32,
    status: CommentStatus,
    message: &str,
) -> Result<bool> {
    // 先加载完整数据找到 comment 的 location
    let data = load_comments(project, task_id)?;
    let comment = data.comments.iter().find(|c| c.id == comment_id);

    if let Some(comment) = comment {
        let mut replies = load_replies(project, task_id)?;
        replies.insert(
            comment.location.clone(),
            ReplyData {
                status,
                reply: message.to_string(),
            },
        );
        save_replies(project, task_id, &replies)?;
        Ok(true)
    } else {
        Ok(false)
    }
}

// ============================================================================
// difit 接口
// ============================================================================

/// 保存 diff review comments（供 difit 写入使用）
///
/// difit 每次全量覆盖此文件，Grove 会从中读取 comments。
/// 同时清理 replies.json，因为新的 comments 和旧的 replies 不再匹配。
pub fn save_diff_comments(project: &str, task_id: &str, content: &str) -> Result<()> {
    let path = diff_comments_path(project, task_id)?;

    // Write with explicit sync to ensure data is flushed to disk
    use std::io::Write;
    let mut file = std::fs::File::create(&path)?;
    file.write_all(content.as_bytes())?;
    file.sync_all()?;

    // Clear old replies since comments have been replaced
    let replies_path = replies_path(project, task_id)?;
    if replies_path.exists() {
        let _ = std::fs::remove_file(replies_path);
    }

    Ok(())
}

/// 删除 AI 数据目录（包含 summary.md, todo.json, replies.json, diff_comments.md）
pub fn delete_ai_data(project: &str, task_id: &str) -> Result<()> {
    let dir = ensure_project_dir(project)?.join("ai").join(task_id);
    if dir.exists() {
        std::fs::remove_dir_all(&dir)?;
    }
    Ok(())
}

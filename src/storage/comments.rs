use std::collections::HashMap;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use super::ensure_project_dir;
use crate::error::Result;

/// Comment 类型
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum CommentType {
    /// Inline code comment (legacy default)
    #[default]
    Inline,
    /// File-level comment (on entire file)
    File,
    /// Project-level comment (not tied to any file)
    Project,
}

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
    ///
    /// 向后兼容旧 JSON 中的 "not_resolved"
    #[serde(alias = "not_resolved")]
    Outdated,
}

/// Comment 回复
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommentReply {
    pub id: u32,
    pub content: String,
    #[serde(default = "default_author")]
    pub author: String,
    #[serde(default = "default_timestamp")]
    pub timestamp: String,
}

fn default_author() -> String {
    "Unknown".to_string()
}

fn default_timestamp() -> String {
    chrono::Utc::now().to_rfc3339()
}

fn default_side() -> String {
    "ADD".to_string()
}

/// 单条 Review Comment
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Comment {
    /// 唯一序号
    pub id: u32,

    /// Comment 类型 (inline, file, or project level)
    #[serde(default)]
    pub comment_type: CommentType,

    /// 文件路径 (required for inline/file, None for project)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_path: Option<String>,

    /// 变更侧: "ADD" | "DELETE" (required for inline, None for file/project)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub side: Option<String>,

    /// 起始行 (required for inline, None for file/project)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub start_line: Option<u32>,

    /// 结束行 (required for inline, None for file/project)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub end_line: Option<u32>,

    /// Comment 内容
    pub content: String,

    /// 作者
    #[serde(default = "default_author")]
    pub author: String,

    /// 时间戳
    #[serde(default = "default_timestamp")]
    pub timestamp: String,

    /// 状态
    #[serde(default)]
    pub status: CommentStatus,

    /// 回复列表
    #[serde(default)]
    pub replies: Vec<CommentReply>,

    /// 创建 comment 时锚定行的代码快照，用于自动 outdated 检测 (only for inline comments)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub anchor_text: Option<String>,

    // --- 旧字段：仅用于反序列化旧格式，不再序列化 ---
    /// 旧格式的位置字符串 (如 "src/main.rs:42")
    #[serde(default, skip_serializing)]
    location: Option<String>,
    /// 旧格式的单条回复
    #[serde(default, skip_serializing)]
    reply: Option<String>,
}

impl Comment {
    /// 将旧格式字段迁移到新格式字段
    fn migrate_legacy(&mut self) {
        // 迁移 location → file_path / start_line / end_line
        if let Some(loc) = self.location.take() {
            if self.file_path.is_none() {
                let (file, (start, end)) = parse_location(&loc);
                self.file_path = Some(file);
                self.start_line = Some(start);
                self.end_line = Some(end);
            }
        }

        // 迁移 reply → replies[0]
        if let Some(reply_text) = self.reply.take() {
            if self.replies.is_empty() && !reply_text.is_empty() {
                self.replies.push(CommentReply {
                    id: 1,
                    content: reply_text,
                    author: "AI".to_string(),
                    timestamp: default_timestamp(),
                });
            }
        }

        // 确保 end_line >= start_line (for inline comments)
        if let (Some(start), None) = (self.start_line, self.end_line) {
            self.end_line = Some(start);
        }
    }

    /// 创建 inline comment (legacy behavior)
    #[allow(clippy::too_many_arguments)]
    pub fn new_inline(
        id: u32,
        file_path: String,
        side: String,
        start_line: u32,
        end_line: u32,
        content: String,
        author: String,
        anchor_text: Option<String>,
    ) -> Self {
        Comment {
            id,
            comment_type: CommentType::Inline,
            file_path: Some(file_path),
            side: Some(side),
            start_line: Some(start_line),
            end_line: Some(end_line),
            content,
            author,
            timestamp: chrono::Utc::now().to_rfc3339(),
            status: CommentStatus::Open,
            replies: Vec::new(),
            anchor_text,
            location: None,
            reply: None,
        }
    }

    /// 创建 file-level comment
    pub fn new_file(id: u32, file_path: String, content: String, author: String) -> Self {
        Comment {
            id,
            comment_type: CommentType::File,
            file_path: Some(file_path),
            side: None,
            start_line: None,
            end_line: None,
            content,
            author,
            timestamp: chrono::Utc::now().to_rfc3339(),
            status: CommentStatus::Open,
            replies: Vec::new(),
            anchor_text: None,
            location: None,
            reply: None,
        }
    }

    /// 创建 project-level comment
    pub fn new_project(id: u32, content: String, author: String) -> Self {
        Comment {
            id,
            comment_type: CommentType::Project,
            file_path: None,
            side: None,
            start_line: None,
            end_line: None,
            content,
            author,
            timestamp: chrono::Utc::now().to_rfc3339(),
            status: CommentStatus::Open,
            replies: Vec::new(),
            anchor_text: None,
            location: None,
            reply: None,
        }
    }

    /// 验证 comment 数据基于类型
    pub fn validate(&self) -> Result<()> {
        match self.comment_type {
            CommentType::Inline => {
                if self.file_path.is_none() {
                    return Err(crate::error::GroveError::Storage(
                        "Inline comment requires file_path".to_string(),
                    ));
                }
                if self.side.is_none() {
                    return Err(crate::error::GroveError::Storage(
                        "Inline comment requires side".to_string(),
                    ));
                }
                if self.start_line.is_none() || self.end_line.is_none() {
                    return Err(crate::error::GroveError::Storage(
                        "Inline comment requires line numbers".to_string(),
                    ));
                }
            }
            CommentType::File => {
                if self.file_path.is_none() {
                    return Err(crate::error::GroveError::Storage(
                        "File comment requires file_path".to_string(),
                    ));
                }
            }
            CommentType::Project => {
                // No required fields
            }
        }
        Ok(())
    }
}

/// 解析旧格式的 location 字符串
///
/// 支持格式:
/// - "src/main.rs:42" → ("src/main.rs", (42, 42))
/// - "src/main.rs:L42" → ("src/main.rs", (42, 42))
/// - "src/app.rs:100-105" → ("src/app.rs", (100, 105))
/// - "src/app.rs:L100-L105" → ("src/app.rs", (100, 105))
pub fn parse_location(loc: &str) -> (String, (u32, u32)) {
    if let Some(colon_pos) = loc.rfind(':') {
        let file = loc[..colon_pos].to_string();
        let line_part = &loc[colon_pos + 1..];

        // 去掉可能的 'L' 前缀
        let line_part = line_part.trim_start_matches('L');

        if let Some(dash_pos) = line_part.find('-') {
            let start_str = &line_part[..dash_pos];
            let end_str = line_part[dash_pos + 1..].trim_start_matches('L');
            let start = start_str.parse::<u32>().unwrap_or(1);
            let end = end_str.parse::<u32>().unwrap_or(start);
            (file, (start, end))
        } else {
            let line = line_part.parse::<u32>().unwrap_or(1);
            (file, (line, line))
        }
    } else {
        // 没有冒号，整个字符串作为文件名
        (loc.to_string(), (1, 1))
    }
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

    /// 统计各状态的数量: (open, resolved, outdated)
    pub fn count_by_status(&self) -> (usize, usize, usize) {
        let mut open = 0;
        let mut resolved = 0;
        let mut outdated = 0;
        for c in &self.comments {
            match c.status {
                CommentStatus::Open => open += 1,
                CommentStatus::Resolved => resolved += 1,
                CommentStatus::Outdated => outdated += 1,
            }
        }
        (open, resolved, outdated)
    }
}

/// AI 回复数据（按 location 索引）— 旧格式
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct ReplyData {
    pub status: CommentStatus,
    pub reply: String,
}

/// replies.json 存储格式 — 旧格式
type RepliesMap = HashMap<String, ReplyData>;

// ============================================================================
// Path helpers
// ============================================================================

/// 新路径: review/<task-id>.json
fn review_path(project: &str, task_id: &str) -> Result<PathBuf> {
    let dir = ensure_project_dir(project)?.join("review");
    std::fs::create_dir_all(&dir)?;
    Ok(dir.join(format!("{}.json", task_id)))
}

/// 旧路径: ai/<task-id>/comments.json (仅用于 fallback 读取，不创建目录)
fn legacy_comments_json_path(project: &str, task_id: &str) -> Result<PathBuf> {
    Ok(ensure_project_dir(project)?
        .join("ai")
        .join(task_id)
        .join("comments.json"))
}

/// 获取 replies.json 存储路径 (旧格式 fallback，不创建目录)
fn replies_path(project: &str, task_id: &str) -> Result<PathBuf> {
    Ok(ensure_project_dir(project)?
        .join("ai")
        .join(task_id)
        .join("replies.json"))
}

/// 获取 diff_comments.md 路径 (旧格式 fallback，不创建目录)
fn diff_comments_path(project: &str, task_id: &str) -> Result<PathBuf> {
    Ok(ensure_project_dir(project)?
        .join("ai")
        .join(task_id)
        .join("diff_comments.md"))
}

// ============================================================================
// JSON format (new)
// ============================================================================

/// 从 JSON 文件加载 CommentsData
///
/// 先查新路径 `review/<task-id>.json`，fallback 旧路径 `ai/<task-id>/comments.json`
fn load_comments_json(project: &str, task_id: &str) -> Result<Option<CommentsData>> {
    // 1. 新路径
    let new_path = review_path(project, task_id)?;
    if new_path.exists() {
        let content = std::fs::read_to_string(&new_path)?;
        let mut data: CommentsData = serde_json::from_str(&content)?;
        for comment in &mut data.comments {
            comment.migrate_legacy();
        }
        return Ok(Some(data));
    }

    // 2. 旧路径 fallback
    let legacy_path = legacy_comments_json_path(project, task_id)?;
    if legacy_path.exists() {
        let content = std::fs::read_to_string(&legacy_path)?;
        let mut data: CommentsData = serde_json::from_str(&content)?;
        for comment in &mut data.comments {
            comment.migrate_legacy();
        }
        return Ok(Some(data));
    }

    Ok(None)
}

/// 保存到 review/<task-id>.json (新路径)
fn save_comments_json(project: &str, task_id: &str, data: &CommentsData) -> Result<()> {
    let path = review_path(project, task_id)?;
    let content = serde_json::to_string_pretty(data)?;
    std::fs::write(&path, content)?;
    Ok(())
}

// ============================================================================
// Legacy format
// ============================================================================

/// 从 diff_comments.md 解析 comments
///
/// Legacy 格式:
/// ```text
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

            let (file_path, (start_line, end_line)) = parse_location(&location);

            comments.push(Comment {
                id,
                comment_type: CommentType::Inline,
                file_path: Some(file_path),
                side: Some(default_side()),
                start_line: Some(start_line),
                end_line: Some(end_line),
                content,
                author: default_author(),
                timestamp: default_timestamp(),
                status: CommentStatus::Open,
                replies: Vec::new(),
                anchor_text: None,
                location: None,
                reply: None,
            });
            id += 1;
        }
    }

    comments
}

/// 加载 AI 回复数据 — 旧格式
fn load_replies(project: &str, task_id: &str) -> Result<RepliesMap> {
    let path = replies_path(project, task_id)?;
    if !path.exists() {
        return Ok(HashMap::new());
    }
    let content = std::fs::read_to_string(&path)?;
    let data = serde_json::from_str(&content)?;
    Ok(data)
}

// ============================================================================
// Anchor / Outdated detection
// ============================================================================

/// 从文本内容中提取 [start_line..=end_line] 行（1-based），用换行符连接
pub fn extract_lines(content: &str, start_line: u32, end_line: u32) -> Option<String> {
    let lines: Vec<&str> = content.lines().collect();
    let start = start_line.saturating_sub(1) as usize;
    let end = end_line as usize;
    if start >= lines.len() || start >= end {
        return None;
    }
    let end = end.min(lines.len());
    Some(lines[start..end].join("\n"))
}

/// 在文件内容中搜索 anchor_text（按行滑动窗口匹配）
///
/// `hint_line` 是评论的原始行号（1-based），用于在多个匹配中选择最近的。
/// 返回找到的起始行号（1-based），未找到返回 None。
pub fn find_anchor(content: &str, anchor: &str, hint_line: Option<u32>) -> Option<u32> {
    let file_lines: Vec<&str> = content.lines().collect();
    let anchor_lines: Vec<&str> = anchor.lines().collect();
    if anchor_lines.is_empty() {
        return None;
    }

    // Collect all matching positions
    let mut matches: Vec<u32> = Vec::new();
    'outer: for i in 0..=file_lines.len().saturating_sub(anchor_lines.len()) {
        for (j, anchor_line) in anchor_lines.iter().enumerate() {
            if file_lines[i + j] != *anchor_line {
                continue 'outer;
            }
        }
        matches.push((i + 1) as u32); // 1-based
    }

    if matches.is_empty() {
        return None;
    }

    // Pick the match closest to hint_line (or first match if no hint)
    match hint_line {
        Some(hint) => matches
            .into_iter()
            .min_by_key(|&m| (m as i64 - hint as i64).unsigned_abs()),
        None => Some(matches[0]),
    }
}

/// 动态检测 outdated 并修正行号漂移（仅修改内存中的数据）
///
/// `read_fn(file_path, side)` 返回指定文件在对应 side 上的完整内容。
/// 返回 true 表示有 comment 的行号被修正（调用方可选择持久化）。
pub fn apply_outdated_detection<F>(data: &mut CommentsData, read_fn: F) -> bool
where
    F: Fn(&str, &str) -> Option<String>,
{
    let mut line_changed = false;

    for comment in &mut data.comments {
        // 仅对 Inline 类型的 Open 且有 anchor_text 的 comment 做检测
        if comment.comment_type != CommentType::Inline || comment.status != CommentStatus::Open {
            continue;
        }
        let anchor = match &comment.anchor_text {
            Some(a) if !a.is_empty() => a.clone(),
            _ => continue,
        };

        let file_path = match &comment.file_path {
            Some(f) => f,
            None => continue,
        };
        let side = match &comment.side {
            Some(s) => s,
            None => continue,
        };

        let content = read_fn(file_path, side);
        match content {
            None => {
                // 文件不存在 → outdated
                comment.status = CommentStatus::Outdated;
            }
            Some(file_content) => {
                if let Some(new_start) = find_anchor(&file_content, &anchor, comment.start_line) {
                    // 找到 → 更新行号（如有位移）
                    if let (Some(start), Some(end)) = (comment.start_line, comment.end_line) {
                        let span = end.saturating_sub(start);
                        if start != new_start {
                            comment.start_line = Some(new_start);
                            comment.end_line = Some(new_start + span);
                            line_changed = true;
                        }
                    }
                } else {
                    // 没找到 → outdated
                    comment.status = CommentStatus::Outdated;
                }
            }
        }
    }

    line_changed
}

/// 保存 comments（公开版本，供外部调用）
pub fn save_comments(project: &str, task_id: &str, data: &CommentsData) -> Result<()> {
    save_comments_json(project, task_id, data)
}

// ============================================================================
// Public API
// ============================================================================

/// 读取 Review Comments
///
/// 策略：优先读取 comments.json（新格式），fallback 到 diff_comments.md + replies.json（旧格式）
pub fn load_comments(project: &str, task_id: &str) -> Result<CommentsData> {
    // 1. 优先读取新格式
    if let Some(data) = load_comments_json(project, task_id)? {
        return Ok(data);
    }

    // 2. Fallback: 从 diff_comments.md + replies.json 读取旧格式
    let diff_path = diff_comments_path(project, task_id)?;
    let mut comments = if diff_path.exists() {
        let content = std::fs::read_to_string(&diff_path)?;
        parse_diff_comments(&content)
    } else {
        Vec::new()
    };

    // 从 replies.json 读取 AI 回复，合并到 comments (仅用于 inline comments)
    let replies = load_replies(project, task_id)?;
    for comment in &mut comments {
        if let (Some(ref fp), Some(sl)) = (&comment.file_path, comment.start_line) {
            let loc_key = format!("{}:{}", fp, sl);
            if let Some(reply_data) = replies.get(&loc_key) {
                comment.status = reply_data.status;
                if !reply_data.reply.is_empty() {
                    comment.replies.push(CommentReply {
                        id: 1,
                        content: reply_data.reply.clone(),
                        author: "AI".to_string(),
                        timestamp: default_timestamp(),
                    });
                }
            }
        }
    }

    Ok(CommentsData { comments })
}

/// 回复 Comment（仅追加回复，不改变 status）
///
/// 向 replies Vec 追加新回复
pub fn reply_comment(
    project: &str,
    task_id: &str,
    comment_id: u32,
    message: &str,
    author: &str,
) -> Result<bool> {
    let mut data = load_comments(project, task_id)?;
    if let Some(comment) = data.comments.iter_mut().find(|c| c.id == comment_id) {
        // 仅当 message 非空时才添加回复记录
        if !message.is_empty() {
            let reply_id = comment.replies.iter().map(|r| r.id).max().unwrap_or(0) + 1;
            comment.replies.push(CommentReply {
                id: reply_id,
                content: message.to_string(),
                author: author.to_string(),
                timestamp: chrono::Utc::now().to_rfc3339(),
            });
        }
        save_comments_json(project, task_id, &data)?;
        Ok(true)
    } else {
        Ok(false)
    }
}

/// 更新 Comment 状态（不添加回复）
///
/// 专门用于改变 comment 的 open/resolved 状态
pub fn update_comment_status(
    project: &str,
    task_id: &str,
    comment_id: u32,
    status: CommentStatus,
) -> Result<bool> {
    let mut data = load_comments(project, task_id)?;
    if let Some(comment) = data.comments.iter_mut().find(|c| c.id == comment_id) {
        comment.status = status;
        save_comments_json(project, task_id, &data)?;
        Ok(true)
    } else {
        Ok(false)
    }
}

/// 添加新 Comment
///
/// 使用新的 comments.json 格式存储。自动分配 ID。
/// `anchor_text`: 锚定行的代码快照，用于自动 outdated 检测（仅用于 inline）。
#[allow(clippy::too_many_arguments)]
pub fn add_comment(
    project: &str,
    task_id: &str,
    comment_type: CommentType,
    file_path: Option<String>,
    side: Option<String>,
    start_line: Option<u32>,
    end_line: Option<u32>,
    content: &str,
    author: &str,
    anchor_text: Option<String>,
) -> Result<Comment> {
    let mut data = load_comments(project, task_id)?;

    // 分配新 ID (最大 id + 1)
    let new_id = data.comments.iter().map(|c| c.id).max().unwrap_or(0) + 1;

    // 创建 comment 基于类型
    let comment = match comment_type {
        CommentType::Inline => Comment::new_inline(
            new_id,
            file_path.ok_or_else(|| {
                crate::error::GroveError::Storage(
                    "file_path required for inline comment".to_string(),
                )
            })?,
            side.ok_or_else(|| {
                crate::error::GroveError::Storage("side required for inline comment".to_string())
            })?,
            start_line.ok_or_else(|| {
                crate::error::GroveError::Storage(
                    "start_line required for inline comment".to_string(),
                )
            })?,
            end_line.unwrap_or_else(|| start_line.unwrap()),
            content.to_string(),
            author.to_string(),
            anchor_text,
        ),
        CommentType::File => Comment::new_file(
            new_id,
            file_path.ok_or_else(|| {
                crate::error::GroveError::Storage("file_path required for file comment".to_string())
            })?,
            content.to_string(),
            author.to_string(),
        ),
        CommentType::Project => {
            Comment::new_project(new_id, content.to_string(), author.to_string())
        }
    };

    // 验证
    comment.validate()?;

    data.comments.push(comment.clone());
    save_comments_json(project, task_id, &data)?;

    Ok(comment)
}

/// 删除 Comment
///
/// 从 comments.json 中删除。如果是旧格式，先迁移到新格式再删除。
pub fn delete_comment(project: &str, task_id: &str, comment_id: u32) -> Result<bool> {
    let mut data = load_comments(project, task_id)?;
    let len_before = data.comments.len();
    data.comments.retain(|c| c.id != comment_id);

    if data.comments.len() < len_before {
        save_comments_json(project, task_id, &data)?;
        Ok(true)
    } else {
        Ok(false)
    }
}

/// 编辑 Comment 内容
pub fn edit_comment(
    project: &str,
    task_id: &str,
    comment_id: u32,
    new_content: &str,
) -> Result<bool> {
    let mut data = load_comments(project, task_id)?;
    if let Some(comment) = data.comments.iter_mut().find(|c| c.id == comment_id) {
        comment.content = new_content.to_string();
        save_comments_json(project, task_id, &data)?;
        Ok(true)
    } else {
        Ok(false)
    }
}

/// 编辑 Reply 内容
pub fn edit_reply(
    project: &str,
    task_id: &str,
    comment_id: u32,
    reply_id: u32,
    new_content: &str,
) -> Result<bool> {
    let mut data = load_comments(project, task_id)?;
    if let Some(comment) = data.comments.iter_mut().find(|c| c.id == comment_id) {
        if let Some(reply) = comment.replies.iter_mut().find(|r| r.id == reply_id) {
            reply.content = new_content.to_string();
            save_comments_json(project, task_id, &data)?;
            return Ok(true);
        }
    }
    Ok(false)
}

/// 删除 Reply
pub fn delete_reply(project: &str, task_id: &str, comment_id: u32, reply_id: u32) -> Result<bool> {
    let mut data = load_comments(project, task_id)?;
    if let Some(comment) = data.comments.iter_mut().find(|c| c.id == comment_id) {
        let len_before = comment.replies.len();
        comment.replies.retain(|r| r.id != reply_id);
        if comment.replies.len() < len_before {
            save_comments_json(project, task_id, &data)?;
            return Ok(true);
        }
    }
    Ok(false)
}

/// 删除 review 数据（新旧路径都清理）
pub fn delete_review_data(project: &str, task_id: &str) -> Result<()> {
    // 新路径: review/<task-id>.json
    let new_path = review_path(project, task_id)?;
    if new_path.exists() {
        std::fs::remove_file(&new_path)?;
    }

    // 旧路径: ai/<task-id>/ (整个目录)
    let legacy_dir = ensure_project_dir(project)?.join("ai").join(task_id);
    if legacy_dir.exists() {
        std::fs::remove_dir_all(&legacy_dir)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_extract_lines_basic() {
        let content = "line1\nline2\nline3\nline4\nline5";
        assert_eq!(
            extract_lines(content, 2, 4),
            Some("line2\nline3\nline4".to_string())
        );
    }

    #[test]
    fn test_extract_lines_single() {
        let content = "aaa\nbbb\nccc";
        assert_eq!(extract_lines(content, 1, 1), Some("aaa".to_string()));
    }

    #[test]
    fn test_extract_lines_out_of_bounds() {
        let content = "a\nb";
        assert_eq!(extract_lines(content, 10, 12), None);
    }

    #[test]
    fn test_extract_lines_clamp_end() {
        let content = "a\nb\nc";
        // end_line=10 should be clamped to 3
        assert_eq!(extract_lines(content, 2, 10), Some("b\nc".to_string()));
    }

    #[test]
    fn test_find_anchor_found() {
        let content = "aaa\nbbb\nccc\nddd\neee";
        assert_eq!(find_anchor(content, "bbb\nccc", None), Some(2));
    }

    #[test]
    fn test_find_anchor_not_found() {
        let content = "aaa\nbbb\nccc";
        assert_eq!(find_anchor(content, "xxx", None), None);
    }

    #[test]
    fn test_find_anchor_shifted() {
        // 模拟代码位移：原来在第2行，现在前面多了一行
        let content = "new_line\naaa\nbbb\nccc";
        assert_eq!(find_anchor(content, "aaa\nbbb", Some(1)), Some(2));
    }

    #[test]
    fn test_find_anchor_empty() {
        let content = "aaa\nbbb";
        assert_eq!(find_anchor(content, "", None), None);
    }

    #[test]
    fn test_find_anchor_nearest_to_hint() {
        // "bbb" 出现在第 2 行和第 4 行，hint=4 应选第 4 行
        let content = "aaa\nbbb\nccc\nbbb\neee";
        assert_eq!(find_anchor(content, "bbb", Some(4)), Some(4));
        // hint=2 应选第 2 行
        assert_eq!(find_anchor(content, "bbb", Some(2)), Some(2));
        // hint=3 有歧义（等距），选较近的其一即可
        let result = find_anchor(content, "bbb", Some(3));
        assert!(result == Some(2) || result == Some(4));
    }

    #[test]
    fn test_apply_outdated_detection_marks_outdated() {
        let mut data = CommentsData {
            comments: vec![Comment {
                id: 1,
                comment_type: CommentType::Inline,
                file_path: Some("src/main.rs".to_string()),
                side: Some("ADD".to_string()),
                start_line: Some(5),
                end_line: Some(5),
                content: "fix this".to_string(),
                author: "You".to_string(),
                timestamp: "2025-01-01".to_string(),
                status: CommentStatus::Open,
                replies: Vec::new(),
                anchor_text: Some("original_code".to_string()),
                location: None,
                reply: None,
            }],
        };

        // 文件内容不包含 anchor_text → 标记 outdated
        apply_outdated_detection(&mut data, |_, _| {
            Some("different_code\nmore_code".to_string())
        });

        assert_eq!(data.comments[0].status, CommentStatus::Outdated);
    }

    #[test]
    fn test_apply_outdated_detection_updates_line() {
        let mut data = CommentsData {
            comments: vec![Comment {
                id: 1,
                comment_type: CommentType::Inline,
                file_path: Some("src/main.rs".to_string()),
                side: Some("ADD".to_string()),
                start_line: Some(2),
                end_line: Some(3),
                content: "fix this".to_string(),
                author: "You".to_string(),
                timestamp: "2025-01-01".to_string(),
                status: CommentStatus::Open,
                replies: Vec::new(),
                anchor_text: Some("bbb\nccc".to_string()),
                location: None,
                reply: None,
            }],
        };

        // 代码位移：anchor 现在从第5行开始
        let changed = apply_outdated_detection(&mut data, |_, _| {
            Some("xxx\nyyy\nzzz\naaa\nbbb\nccc\nddd".to_string())
        });

        assert!(changed);
        assert_eq!(data.comments[0].status, CommentStatus::Open);
        assert_eq!(data.comments[0].start_line, Some(5));
        assert_eq!(data.comments[0].end_line, Some(6));
    }

    #[test]
    fn test_apply_outdated_detection_skips_resolved() {
        let mut data = CommentsData {
            comments: vec![Comment {
                id: 1,
                comment_type: CommentType::Inline,
                file_path: Some("src/main.rs".to_string()),
                side: Some("ADD".to_string()),
                start_line: Some(1),
                end_line: Some(1),
                content: "fix this".to_string(),
                author: "You".to_string(),
                timestamp: "2025-01-01".to_string(),
                status: CommentStatus::Resolved,
                replies: Vec::new(),
                anchor_text: Some("old_code".to_string()),
                location: None,
                reply: None,
            }],
        };

        // Resolved comment 不应被检测
        apply_outdated_detection(&mut data, |_, _| Some("different_code".to_string()));

        assert_eq!(data.comments[0].status, CommentStatus::Resolved);
    }

    #[test]
    fn test_apply_outdated_detection_no_anchor() {
        let mut data = CommentsData {
            comments: vec![Comment {
                id: 1,
                comment_type: CommentType::Inline,
                file_path: Some("src/main.rs".to_string()),
                side: Some("ADD".to_string()),
                start_line: Some(1),
                end_line: Some(1),
                content: "fix this".to_string(),
                author: "You".to_string(),
                timestamp: "2025-01-01".to_string(),
                status: CommentStatus::Open,
                replies: Vec::new(),
                anchor_text: None,
                location: None,
                reply: None,
            }],
        };

        // 无 anchor_text → 不参与检测，保持 Open
        apply_outdated_detection(&mut data, |_, _| Some("whatever".to_string()));

        assert_eq!(data.comments[0].status, CommentStatus::Open);
    }

    #[test]
    fn test_apply_outdated_detection_file_missing() {
        let mut data = CommentsData {
            comments: vec![Comment {
                id: 1,
                comment_type: CommentType::Inline,
                file_path: Some("deleted.rs".to_string()),
                side: Some("ADD".to_string()),
                start_line: Some(1),
                end_line: Some(1),
                content: "fix this".to_string(),
                author: "You".to_string(),
                timestamp: "2025-01-01".to_string(),
                status: CommentStatus::Open,
                replies: Vec::new(),
                anchor_text: Some("some_code".to_string()),
                location: None,
                reply: None,
            }],
        };

        // 文件不存在 → outdated
        apply_outdated_detection(&mut data, |_, _| None);

        assert_eq!(data.comments[0].status, CommentStatus::Outdated);
    }
}

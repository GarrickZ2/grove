use serde::{Deserialize, Serialize};

use super::database;
use crate::error::Result;

/// Comment 类型
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum CommentType {
    #[default]
    Inline,
    File,
    Project,
}

/// Comment 状态
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum CommentStatus {
    #[default]
    Open,
    Resolved,
    #[serde(alias = "not_resolved")]
    Outdated,
}

// ============================================================================
// Enum ↔ string helpers
// ============================================================================

fn comment_type_to_str(ct: CommentType) -> &'static str {
    match ct {
        CommentType::Inline => "inline",
        CommentType::File => "file",
        CommentType::Project => "project",
    }
}

fn comment_type_from_str(s: &str) -> CommentType {
    match s {
        "file" => CommentType::File,
        "project" => CommentType::Project,
        _ => CommentType::Inline,
    }
}

fn status_to_str(s: CommentStatus) -> &'static str {
    match s {
        CommentStatus::Open => "open",
        CommentStatus::Resolved => "resolved",
        CommentStatus::Outdated => "outdated",
    }
}

fn status_from_str(s: &str) -> CommentStatus {
    match s {
        "resolved" => CommentStatus::Resolved,
        "outdated" => CommentStatus::Outdated,
        _ => CommentStatus::Open,
    }
}

/// Parse old `author` string (e.g. "Claude Code (Reviewer)") into (agent, role).
pub fn parse_author_to_agent_role(author: &str) -> (String, String) {
    if let Some(open) = author.rfind('(') {
        if let Some(close) = author.rfind(')') {
            if close > open {
                let agent = author[..open].trim();
                let role = author[open + 1..close].trim();
                return (agent.to_string(), role.to_string());
            }
        }
    }
    (author.to_string(), String::new())
}

/// Build display "author" string from agent + role.
/// ─ kept public for MCP response types and frontend migration helpers.
pub fn build_author(agent: &str, role: &str) -> String {
    if agent.is_empty() {
        return "Unknown".to_string();
    }
    if role.is_empty() {
        return agent.to_string();
    }
    format!("{} ({})", agent, role)
}

/// Comment 回复
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommentReply {
    pub id: u32,
    pub content: String,
    #[serde(default)]
    pub agent: String,
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub role: String,
    #[serde(default = "default_timestamp")]
    pub timestamp: String,
}

/// 单条 Review Comment
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Comment {
    pub id: u32,

    #[serde(default)]
    pub comment_type: CommentType,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_path: Option<String>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub side: Option<String>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub start_line: Option<u32>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub end_line: Option<u32>,

    pub content: String,

    #[serde(default)]
    pub agent: String,

    #[serde(default)]
    pub model: String,

    #[serde(default)]
    pub role: String,

    #[serde(default = "default_timestamp")]
    pub timestamp: String,

    #[serde(default)]
    pub status: CommentStatus,

    #[serde(default)]
    pub replies: Vec<CommentReply>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub anchor_text: Option<String>,
}

fn default_timestamp() -> String {
    chrono::Utc::now().to_rfc3339()
}

impl Comment {
    #[allow(clippy::too_many_arguments)]
    fn build(
        id: u32,
        comment_type: CommentType,
        file_path: Option<String>,
        side: Option<String>,
        start_line: Option<u32>,
        end_line: Option<u32>,
        content: String,
        agent: String,
        model: String,
        role: String,
        anchor_text: Option<String>,
    ) -> Self {
        Comment {
            id,
            comment_type,
            file_path,
            side,
            start_line,
            end_line,
            content,
            agent,
            model,
            role,
            timestamp: chrono::Utc::now().to_rfc3339(),
            status: CommentStatus::Open,
            replies: Vec::new(),
            anchor_text,
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
            CommentType::Project => {}
        }
        Ok(())
    }
}

/// 解析 location 字符串
pub fn parse_location(loc: &str) -> (String, (u32, u32)) {
    if let Some(colon_pos) = loc.rfind(':') {
        let file = loc[..colon_pos].to_string();
        let line_part = &loc[colon_pos + 1..];

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

// ============================================================================
// Anchor / Outdated detection
// ============================================================================

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

pub fn find_anchor(content: &str, anchor: &str, hint_line: Option<u32>) -> Option<u32> {
    let file_lines: Vec<&str> = content.lines().collect();
    let anchor_lines: Vec<&str> = anchor.lines().collect();
    if anchor_lines.is_empty() {
        return None;
    }

    let mut matches: Vec<u32> = Vec::new();
    'outer: for i in 0..=file_lines.len().saturating_sub(anchor_lines.len()) {
        for (j, anchor_line) in anchor_lines.iter().enumerate() {
            if file_lines[i + j] != *anchor_line {
                continue 'outer;
            }
        }
        matches.push((i + 1) as u32);
    }

    if matches.is_empty() {
        return None;
    }

    match hint_line {
        Some(hint) => matches
            .into_iter()
            .min_by_key(|&m| (m as i64 - hint as i64).unsigned_abs()),
        None => Some(matches[0]),
    }
}

pub fn apply_outdated_detection<F>(data: &mut CommentsData, read_fn: F) -> bool
where
    F: Fn(&str, &str) -> Option<String>,
{
    let mut line_changed = false;

    for comment in &mut data.comments {
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
                comment.status = CommentStatus::Outdated;
            }
            Some(file_content) => {
                let file_line_count = file_content.lines().count().max(1) as u32;

                if let Some(new_start) = find_anchor(&file_content, &anchor, comment.start_line) {
                    if let (Some(start), Some(end)) = (comment.start_line, comment.end_line) {
                        let span = end.saturating_sub(start);
                        if start != new_start {
                            comment.start_line = Some(new_start);
                            comment.end_line = Some(new_start + span);
                            line_changed = true;
                        }
                    }
                } else {
                    comment.status = CommentStatus::Outdated;
                    if let (Some(start), Some(end)) = (comment.start_line, comment.end_line) {
                        if end > file_line_count {
                            let span = end.saturating_sub(start);
                            comment.end_line = Some(file_line_count);
                            comment.start_line = Some(file_line_count.saturating_sub(span).max(1));
                            line_changed = true;
                        }
                    }
                }
            }
        }
    }

    line_changed
}

// ============================================================================
// SQLite persistence helpers
// ============================================================================

fn load_replies_for_comment(
    conn: &rusqlite::Connection,
    project_key: &str,
    task_id: &str,
    comment_id: u32,
) -> Result<Vec<CommentReply>> {
    let mut stmt = conn.prepare(
        "SELECT id, content, agent, model_name, role, timestamp
         FROM review_replies
         WHERE project_key = ?1 AND task_id = ?2 AND comment_id = ?3
         ORDER BY id",
    )?;
    let rows = stmt.query_map(rusqlite::params![project_key, task_id, comment_id], |row| {
        Ok(CommentReply {
            id: row.get(0)?,
            content: row.get(1)?,
            agent: row.get::<_, String>(2).unwrap_or_default(),
            model: row.get::<_, String>(3).unwrap_or_default(),
            role: row.get::<_, String>(4).unwrap_or_default(),
            timestamp: row.get(5)?,
        })
    })?;

    Ok(rows.filter_map(|r| r.ok()).collect())
}

// ============================================================================
// Public API
// ============================================================================

/// 读取 Review Comments
pub fn load_comments(project: &str, task_id: &str) -> Result<CommentsData> {
    let conn = database::connection();

    let mut stmt = conn.prepare(
        "SELECT id, comment_type, file_path, side, start_line, end_line,
                content, agent, model_name, role, timestamp, status, anchor_text
         FROM review_comments
         WHERE project_key = ?1 AND task_id = ?2
         ORDER BY id",
    )?;

    let rows = stmt.query_map(rusqlite::params![project, task_id], |row| {
        let id: u32 = row.get(0)?;
        let comment_type_str: String = row.get(1)?;
        let file_path: Option<String> = row.get(2)?;
        let side: Option<String> = row.get(3)?;
        let start_line: Option<u32> = row.get(4)?;
        let end_line: Option<u32> = row.get(5)?;
        let content: String = row.get(6)?;
        let agent: String = row.get::<_, String>(7).unwrap_or_default();
        let model: String = row.get::<_, String>(8).unwrap_or_default();
        let role: String = row.get::<_, String>(9).unwrap_or_default();
        let timestamp: String = row.get(10)?;
        let status_str: String = row.get(11)?;
        let anchor_text: Option<String> = row.get(12)?;
        Ok((
            id,
            comment_type_str,
            file_path,
            side,
            start_line,
            end_line,
            content,
            agent,
            model,
            role,
            timestamp,
            status_str,
            anchor_text,
        ))
    })?;

    let mut comments = Vec::new();
    for row in rows {
        let (
            id,
            comment_type_str,
            file_path,
            side,
            start_line,
            end_line,
            content,
            agent,
            model,
            role,
            timestamp,
            status_str,
            anchor_text,
        ) = row?;

        let comment_type = comment_type_from_str(&comment_type_str);
        let status = status_from_str(&status_str);
        let replies = load_replies_for_comment(&conn, project, task_id, id)?;

        let comment = Comment {
            id,
            comment_type,
            file_path,
            side,
            start_line,
            end_line,
            content,
            agent,
            model,
            role,
            timestamp,
            status,
            replies,
            anchor_text,
        };
        comment.validate()?;
        comments.push(comment);
    }

    Ok(CommentsData { comments })
}

/// 回复 Comment（仅追加回复，不改变 status）
pub fn reply_comment(
    project: &str,
    task_id: &str,
    comment_id: u32,
    message: &str,
    agent: &str,
    model: &str,
    role: &str,
) -> Result<bool> {
    let conn = database::connection();

    let exists: bool = conn
        .query_row(
            "SELECT COUNT(*) > 0 FROM review_comments WHERE project_key = ?1 AND task_id = ?2 AND id = ?3",
            rusqlite::params![project, task_id, comment_id],
            |row| row.get(0),
        )
        .unwrap_or(false);

    if !exists {
        return Ok(false);
    }

    if !message.is_empty() {
        let next_id: u32 = conn
            .query_row(
                "SELECT COALESCE(MAX(id), 0) + 1 FROM review_replies WHERE project_key = ?1 AND task_id = ?2 AND comment_id = ?3",
                rusqlite::params![project, task_id, comment_id],
                |row| row.get(0),
            )
            .unwrap_or(1);

        let now = chrono::Utc::now().to_rfc3339();
        conn.execute(
            "INSERT INTO review_replies (id, comment_id, project_key, task_id, content, agent, model_name, role, timestamp)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            rusqlite::params![next_id, comment_id, project, task_id, message, agent, model, role, now],
        )?;
    }

    Ok(true)
}

/// 更新 Comment 状态（不添加回复）
pub fn update_comment_status(
    project: &str,
    task_id: &str,
    comment_id: u32,
    status: CommentStatus,
) -> Result<bool> {
    let conn = database::connection();
    let status_str = status_to_str(status);
    let updated = conn.execute(
        "UPDATE review_comments SET status = ?1 WHERE project_key = ?2 AND task_id = ?3 AND id = ?4",
        rusqlite::params![status_str, project, task_id, comment_id],
    )?;
    Ok(updated > 0)
}

/// 添加新 Comment
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
    agent: &str,
    model: &str,
    role: &str,
    anchor_text: Option<String>,
) -> Result<Comment> {
    let conn = database::connection();

    let new_id: u32 = conn
        .query_row(
            "SELECT COALESCE(MAX(id), 0) + 1 FROM review_comments WHERE project_key = ?1 AND task_id = ?2",
            rusqlite::params![project, task_id],
            |row| row.get(0),
        )
        .unwrap_or(1);

    // Inline comments require a non-null end_line; default to start_line when caller omits it.
    let end_line = match comment_type {
        CommentType::Inline => end_line.or(start_line),
        _ => end_line,
    };

    let comment = Comment::build(
        new_id,
        comment_type,
        file_path,
        side,
        start_line,
        end_line,
        content.to_string(),
        agent.to_string(),
        model.to_string(),
        role.to_string(),
        anchor_text,
    );
    comment.validate()?;

    let comment_type_str = comment_type_to_str(comment_type);
    let status_str = status_to_str(CommentStatus::Open);

    conn.execute(
        "INSERT INTO review_comments (id, project_key, task_id, comment_type, file_path, side, start_line, end_line, content, agent, model_name, role, timestamp, status, anchor_text)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)",
        rusqlite::params![
            comment.id,
            project,
            task_id,
            comment_type_str,
            comment.file_path,
            comment.side,
            comment.start_line,
            comment.end_line,
            comment.content,
            comment.agent,
            comment.model,
            comment.role,
            comment.timestamp,
            status_str,
            comment.anchor_text,
        ],
    )?;

    Ok(comment)
}

/// 保存 comments（供 outdated detection 后持久化行号和状态变更）
pub fn save_comments(project: &str, task_id: &str, data: &CommentsData) -> Result<()> {
    let conn = database::connection();
    for comment in &data.comments {
        conn.execute(
            "UPDATE review_comments SET status = ?1, start_line = ?2, end_line = ?3 WHERE project_key = ?4 AND task_id = ?5 AND id = ?6",
            rusqlite::params![
                status_to_str(comment.status),
                comment.start_line,
                comment.end_line,
                project,
                task_id,
                comment.id,
            ],
        )?;
    }
    Ok(())
}

/// 批量删除 Comments（按 status 和 agent 过滤）
pub fn bulk_delete_comments(
    project: &str,
    task_id: &str,
    statuses: &[CommentStatus],
    authors: &[String],
) -> Result<usize> {
    let conn = database::connection();

    let mut conditions = vec!["project_key = ?1".to_string(), "task_id = ?2".to_string()];
    let mut param_values: Vec<Box<dyn rusqlite::types::ToSql>> =
        vec![Box::new(project.to_string()), Box::new(task_id.to_string())];

    if !statuses.is_empty() {
        let placeholders: Vec<String> = statuses
            .iter()
            .enumerate()
            .map(|(i, _)| format!("?{}", param_values.len() + 1 + i))
            .collect();
        conditions.push(format!("status IN ({})", placeholders.join(", ")));
        for s in statuses {
            param_values.push(Box::new(status_to_str(*s).to_string()));
        }
    }

    if !authors.is_empty() {
        let placeholders: Vec<String> = authors
            .iter()
            .enumerate()
            .map(|(i, _)| format!("?{}", param_values.len() + 1 + i))
            .collect();
        // Match either the bare agent column or the legacy display string
        // "agent (role)". When role is empty, the legacy form falls back to
        // bare agent (without trailing " ()") so the first clause still
        // catches it.
        conditions.push(format!(
            "(agent IN ({0}) OR (CASE WHEN role = '' THEN agent ELSE agent || ' (' || role || ')' END) IN ({0}))",
            placeholders.join(", ")
        ));
        for a in authors {
            param_values.push(Box::new(a.clone()));
        }
    }

    let where_clause = conditions.join(" AND ");
    let sql = format!("DELETE FROM review_comments WHERE {}", where_clause);

    let params: Vec<&dyn rusqlite::types::ToSql> =
        param_values.iter().map(|p| p.as_ref()).collect();
    let deleted = conn.execute(&sql, rusqlite::params_from_iter(params))?;
    Ok(deleted)
}

/// 删除 Comment
pub fn delete_comment(project: &str, task_id: &str, comment_id: u32) -> Result<bool> {
    let conn = database::connection();
    let deleted = conn.execute(
        "DELETE FROM review_comments WHERE project_key = ?1 AND task_id = ?2 AND id = ?3",
        rusqlite::params![project, task_id, comment_id],
    )?;
    Ok(deleted > 0)
}

/// 编辑 Comment 内容
pub fn edit_comment(
    project: &str,
    task_id: &str,
    comment_id: u32,
    new_content: &str,
) -> Result<bool> {
    let conn = database::connection();
    let updated = conn.execute(
        "UPDATE review_comments SET content = ?1 WHERE project_key = ?2 AND task_id = ?3 AND id = ?4",
        rusqlite::params![new_content, project, task_id, comment_id],
    )?;
    Ok(updated > 0)
}

/// 编辑 Reply 内容
pub fn edit_reply(
    project: &str,
    task_id: &str,
    comment_id: u32,
    reply_id: u32,
    new_content: &str,
) -> Result<bool> {
    let conn = database::connection();
    let updated = conn.execute(
        "UPDATE review_replies SET content = ?1 WHERE project_key = ?2 AND task_id = ?3 AND comment_id = ?4 AND id = ?5",
        rusqlite::params![new_content, project, task_id, comment_id, reply_id],
    )?;
    Ok(updated > 0)
}

/// 删除 Reply
pub fn delete_reply(project: &str, task_id: &str, comment_id: u32, reply_id: u32) -> Result<bool> {
    let conn = database::connection();
    let deleted = conn.execute(
        "DELETE FROM review_replies WHERE project_key = ?1 AND task_id = ?2 AND comment_id = ?3 AND id = ?4",
        rusqlite::params![project, task_id, comment_id, reply_id],
    )?;
    Ok(deleted > 0)
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
        let content = "aaa\nbbb\nccc\nbbb\neee";
        assert_eq!(find_anchor(content, "bbb", Some(4)), Some(4));
        assert_eq!(find_anchor(content, "bbb", Some(2)), Some(2));
        let result = find_anchor(content, "bbb", Some(3));
        assert!(result == Some(2) || result == Some(4));
    }

    #[test]
    fn test_parse_author_to_agent_role() {
        assert_eq!(
            parse_author_to_agent_role("Claude Code (Reviewer)"),
            ("Claude Code".to_string(), "Reviewer".to_string())
        );
        assert_eq!(
            parse_author_to_agent_role("Claude Code"),
            ("Claude Code".to_string(), String::new())
        );
        assert_eq!(
            parse_author_to_agent_role("You"),
            ("You".to_string(), String::new())
        );
        assert_eq!(
            parse_author_to_agent_role("Codex (Implementer)"),
            ("Codex".to_string(), "Implementer".to_string())
        );
    }

    #[test]
    fn test_build_author() {
        assert_eq!(
            build_author("Claude Code", "Reviewer"),
            "Claude Code (Reviewer)"
        );
        assert_eq!(build_author("Claude Code", ""), "Claude Code");
        assert_eq!(build_author("You", ""), "You");
        assert_eq!(build_author("", ""), "Unknown");
    }

    fn test_comment() -> Comment {
        Comment {
            id: 1,
            comment_type: CommentType::Inline,
            file_path: Some("src/main.rs".to_string()),
            side: Some("ADD".to_string()),
            start_line: Some(5),
            end_line: Some(5),
            content: "fix this".to_string(),
            agent: "You".to_string(),
            model: String::new(),
            role: String::new(),
            timestamp: "2025-01-01".to_string(),
            status: CommentStatus::Open,
            replies: Vec::new(),
            anchor_text: Some("original_code".to_string()),
        }
    }

    #[test]
    fn test_outdated_detection_marks_outdated() {
        let mut data = CommentsData {
            comments: vec![test_comment()],
        };

        apply_outdated_detection(&mut data, |_, _| {
            Some("different_code\nmore_code".to_string())
        });

        assert_eq!(data.comments[0].status, CommentStatus::Outdated);
    }

    #[test]
    fn test_outdated_detection_updates_line() {
        let mut comment = test_comment();
        comment.anchor_text = Some("bbb\nccc".to_string());
        comment.start_line = Some(2);
        comment.end_line = Some(3);
        let mut data = CommentsData {
            comments: vec![comment],
        };

        let changed = apply_outdated_detection(&mut data, |_, _| {
            Some("xxx\nyyy\nzzz\naaa\nbbb\nccc\nddd".to_string())
        });

        assert!(changed);
        assert_eq!(data.comments[0].status, CommentStatus::Open);
        assert_eq!(data.comments[0].start_line, Some(5));
        assert_eq!(data.comments[0].end_line, Some(6));
    }

    #[test]
    fn test_outdated_detection_skips_resolved() {
        let mut comment = test_comment();
        comment.status = CommentStatus::Resolved;
        let mut data = CommentsData {
            comments: vec![comment],
        };

        apply_outdated_detection(&mut data, |_, _| Some("different_code".to_string()));

        assert_eq!(data.comments[0].status, CommentStatus::Resolved);
    }

    #[test]
    fn test_outdated_detection_no_anchor() {
        let mut comment = test_comment();
        comment.anchor_text = None;
        let mut data = CommentsData {
            comments: vec![comment],
        };

        apply_outdated_detection(&mut data, |_, _| Some("whatever".to_string()));

        assert_eq!(data.comments[0].status, CommentStatus::Open);
    }

    #[test]
    fn test_outdated_detection_file_missing() {
        let mut comment = test_comment();
        comment.file_path = Some("deleted.rs".to_string());
        comment.anchor_text = Some("some_code".to_string());
        let mut data = CommentsData {
            comments: vec![comment],
        };

        apply_outdated_detection(&mut data, |_, _| None);

        assert_eq!(data.comments[0].status, CommentStatus::Outdated);
    }
}

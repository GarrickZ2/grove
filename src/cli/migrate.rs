//! Storage migration: legacy layout → task-centric layout (v1.0)
//!
//! Migrates per-task data from scattered directories into unified `tasks/<task-id>/` folders.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::storage;
use crate::storage::comments::{CommentReply, CommentStatus, CommentType, CommentsData};

// ============================================================================
// Legacy format types (self-contained for migration)
// ============================================================================

/// Comment with legacy fields for deserialization
#[derive(Debug, Clone, Serialize, Deserialize)]
struct LegacyComment {
    #[serde(default)]
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
    #[serde(default = "default_author")]
    pub author: String,
    #[serde(default = "default_timestamp")]
    pub timestamp: String,
    #[serde(default)]
    pub status: CommentStatus,
    #[serde(default)]
    pub replies: Vec<CommentReply>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub anchor_text: Option<String>,
    /// Legacy location field
    #[serde(default)]
    location: Option<String>,
    /// Legacy single reply field
    #[serde(default)]
    reply: Option<String>,
}

fn default_author() -> String {
    "Unknown".to_string()
}

fn default_timestamp() -> String {
    chrono::Utc::now().to_rfc3339()
}

/// Legacy CommentsData for deserialization
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct LegacyCommentsData {
    #[serde(default)]
    pub comments: Vec<LegacyComment>,
}

/// Legacy reply data
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct ReplyData {
    pub status: CommentStatus,
    pub reply: String,
}

type RepliesMap = HashMap<String, ReplyData>;

impl LegacyComment {
    /// Convert to new Comment format, migrating legacy fields
    fn into_new_comment(mut self) -> crate::storage::comments::Comment {
        // Migrate location → file_path / start_line / end_line
        if let Some(loc) = self.location.take() {
            if self.file_path.is_none() {
                let (file, (start, end)) = crate::storage::comments::parse_location(&loc);
                self.file_path = Some(file);
                self.start_line = Some(start);
                self.end_line = Some(end);
            }
        }

        // Migrate reply → replies[0]
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

        // Ensure end_line >= start_line
        if let (Some(start), None) = (self.start_line, self.end_line) {
            self.end_line = Some(start);
        }

        crate::storage::comments::Comment {
            id: self.id,
            comment_type: self.comment_type,
            file_path: self.file_path,
            side: self.side,
            start_line: self.start_line,
            end_line: self.end_line,
            content: self.content,
            author: self.author,
            timestamp: self.timestamp,
            status: self.status,
            replies: self.replies,
            anchor_text: self.anchor_text,
        }
    }
}

// ============================================================================
// Legacy format parsers
// ============================================================================

/// Parse diff_comments.md (oldest format)
fn parse_diff_comments(content: &str) -> Vec<crate::storage::comments::Comment> {
    let mut comments = Vec::new();
    let mut id = 1u32;

    for block in content.split("\n=====\n") {
        let block = block.trim();
        if block.is_empty() {
            continue;
        }

        let mut lines = block.lines();
        if let Some(location) = lines.next() {
            let location = location.trim().to_string();
            if location.is_empty() {
                continue;
            }

            let body: String = lines.collect::<Vec<_>>().join("\n").trim().to_string();
            if body.is_empty() {
                continue;
            }

            let (file_path, (start_line, end_line)) =
                crate::storage::comments::parse_location(&location);

            comments.push(crate::storage::comments::Comment {
                id,
                comment_type: CommentType::Inline,
                file_path: Some(file_path),
                side: Some("ADD".to_string()),
                start_line: Some(start_line),
                end_line: Some(end_line),
                content: body,
                author: default_author(),
                timestamp: default_timestamp(),
                status: CommentStatus::Open,
                replies: Vec::new(),
                anchor_text: None,
            });
            id += 1;
        }
    }

    comments
}

/// Load replies.json (oldest format)
fn load_replies_file(path: &Path) -> RepliesMap {
    if !path.exists() {
        return HashMap::new();
    }
    fs::read_to_string(path)
        .ok()
        .and_then(|content| serde_json::from_str(&content).ok())
        .unwrap_or_default()
}

// ============================================================================
// Migration stats
// ============================================================================

struct MigrationStats {
    notes_migrated: u32,
    review_migrated: u32,
    activity_migrated: u32,
    orphans_cleaned: u32,
    dirs_cleaned: u32,
}

impl MigrationStats {
    fn new() -> Self {
        Self {
            notes_migrated: 0,
            review_migrated: 0,
            activity_migrated: 0,
            orphans_cleaned: 0,
            dirs_cleaned: 0,
        }
    }

    fn total(&self) -> u32 {
        self.notes_migrated + self.review_migrated + self.activity_migrated
    }
}

// ============================================================================
// Migration logic
// ============================================================================

/// Execute storage migration for all projects
pub fn execute(dry_run: bool) {
    let projects_dir = storage::grove_dir().join("projects");
    if !projects_dir.exists() {
        if !dry_run {
            eprintln!("No projects directory found, nothing to migrate.");
        }
        return;
    }

    let entries = match fs::read_dir(&projects_dir) {
        Ok(e) => e,
        Err(e) => {
            eprintln!("Failed to read projects directory: {}", e);
            return;
        }
    };

    let mut total_stats = MigrationStats::new();
    let mut task_modes_migrated = 0u32;

    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let project_key = match path.file_name().and_then(|n| n.to_str()) {
            Some(name) => name.to_string(),
            None => continue,
        };

        let stats = migrate_project(&project_key, &path, dry_run);
        total_stats.notes_migrated += stats.notes_migrated;
        total_stats.review_migrated += stats.review_migrated;
        total_stats.activity_migrated += stats.activity_migrated;
        total_stats.orphans_cleaned += stats.orphans_cleaned;
        total_stats.dirs_cleaned += stats.dirs_cleaned;

        // v1.0 → v1.1: Migrate task_modes field
        task_modes_migrated += migrate_task_modes_v1_1(&project_key, dry_run);
    }

    // Update storage version to 1.1
    if !dry_run && task_modes_migrated > 0 {
        if let Err(e) = update_storage_version("1.1") {
            eprintln!("Warning: failed to update storage version: {}", e);
        }
    }

    // Summary
    if total_stats.total() > 0 || total_stats.orphans_cleaned > 0 || task_modes_migrated > 0 {
        let prefix = if dry_run { "[dry-run] " } else { "" };
        eprintln!(
            "{}Migration complete: {} notes, {} review, {} activity migrated. {} orphans cleaned. {} old dirs removed. {} task_modes migrated.",
            prefix,
            total_stats.notes_migrated,
            total_stats.review_migrated,
            total_stats.activity_migrated,
            total_stats.orphans_cleaned,
            total_stats.dirs_cleaned,
            task_modes_migrated,
        );
    } else {
        eprintln!("Nothing to migrate.");
    }
}

fn migrate_project(project_key: &str, project_dir: &Path, dry_run: bool) -> MigrationStats {
    let mut stats = MigrationStats::new();

    // Collect known task IDs from tasks.toml + archived.toml
    let known_ids = collect_known_task_ids(project_dir);

    // Migrate notes/<id>.md → tasks/<id>/notes.md
    migrate_notes(project_key, project_dir, &known_ids, dry_run, &mut stats);

    // Migrate review data (multiple legacy formats)
    migrate_review(project_key, project_dir, &known_ids, dry_run, &mut stats);

    // Migrate activity data
    migrate_activity(project_key, project_dir, &known_ids, dry_run, &mut stats);

    // Clean empty old directories
    for dir_name in &["notes", "review", "activity", "ai"] {
        let old_dir = project_dir.join(dir_name);
        if old_dir.exists() && is_dir_empty_or_has_no_files(&old_dir) {
            if dry_run {
                eprintln!("  [dry-run] Would remove empty dir: {}/", dir_name);
            } else {
                let _ = fs::remove_dir_all(&old_dir);
            }
            stats.dirs_cleaned += 1;
        }
    }

    stats
}

fn collect_known_task_ids(project_dir: &Path) -> HashSet<String> {
    let mut ids = HashSet::new();

    // Parse tasks.toml
    if let Ok(content) = fs::read_to_string(project_dir.join("tasks.toml")) {
        if let Ok(data) = toml::from_str::<toml::Value>(&content) {
            if let Some(tasks) = data.get("tasks").and_then(|t| t.as_array()) {
                for task in tasks {
                    if let Some(id) = task.get("id").and_then(|i| i.as_str()) {
                        ids.insert(id.to_string());
                    }
                }
            }
        }
    }

    // Parse archived.toml
    if let Ok(content) = fs::read_to_string(project_dir.join("archived.toml")) {
        if let Ok(data) = toml::from_str::<toml::Value>(&content) {
            if let Some(tasks) = data.get("tasks").and_then(|t| t.as_array()) {
                for task in tasks {
                    if let Some(id) = task.get("id").and_then(|i| i.as_str()) {
                        ids.insert(id.to_string());
                    }
                }
            }
        }
    }

    ids
}

fn migrate_notes(
    project_key: &str,
    project_dir: &Path,
    known_ids: &HashSet<String>,
    dry_run: bool,
    stats: &mut MigrationStats,
) {
    let notes_dir = project_dir.join("notes");
    if !notes_dir.exists() {
        return;
    }

    let entries = match fs::read_dir(&notes_dir) {
        Ok(e) => e,
        Err(_) => return,
    };

    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let file_name = match path.file_name().and_then(|n| n.to_str()) {
            Some(name) => name.to_string(),
            None => continue,
        };

        // notes/<id>.md
        if let Some(task_id) = file_name.strip_suffix(".md") {
            if !known_ids.contains(task_id) {
                // Orphan
                if dry_run {
                    eprintln!("  [dry-run] Would clean orphan notes: {}", file_name);
                } else {
                    let _ = fs::remove_file(&path);
                }
                stats.orphans_cleaned += 1;
                continue;
            }

            let target = new_task_dir(project_key, task_id).join("notes.md");
            if target.exists() {
                // Already migrated, just remove old
                if !dry_run {
                    let _ = fs::remove_file(&path);
                }
                continue;
            }

            if dry_run {
                eprintln!(
                    "  [dry-run] Would migrate notes/{}.md → tasks/{}/notes.md",
                    task_id, task_id
                );
            } else if let Err(e) = ensure_and_move(&path, &target) {
                eprintln!("  Failed to migrate notes for {}: {}", task_id, e);
                continue;
            }
            stats.notes_migrated += 1;
        }
    }
}

fn migrate_review(
    project_key: &str,
    project_dir: &Path,
    known_ids: &HashSet<String>,
    dry_run: bool,
    stats: &mut MigrationStats,
) {
    // Collect task IDs that already have review.json in new location
    let mut already_migrated = HashSet::new();
    let tasks_dir = project_dir.join("tasks");
    if tasks_dir.exists() {
        if let Ok(entries) = fs::read_dir(&tasks_dir) {
            for entry in entries.flatten() {
                if entry.path().join("review.json").exists() {
                    if let Some(id) = entry.file_name().to_str() {
                        already_migrated.insert(id.to_string());
                    }
                }
            }
        }
    }

    // 1. review/<id>.json (mid-generation)
    let review_dir = project_dir.join("review");
    if review_dir.exists() {
        if let Ok(entries) = fs::read_dir(&review_dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if !path.is_file() {
                    continue;
                }
                let file_name = match path.file_name().and_then(|n| n.to_str()) {
                    Some(name) => name.to_string(),
                    None => continue,
                };

                if let Some(task_id) = file_name.strip_suffix(".json") {
                    if !known_ids.contains(task_id) {
                        if dry_run {
                            eprintln!("  [dry-run] Would clean orphan review: {}", file_name);
                        } else {
                            let _ = fs::remove_file(&path);
                        }
                        stats.orphans_cleaned += 1;
                        continue;
                    }

                    if already_migrated.contains(task_id) {
                        if !dry_run {
                            let _ = fs::remove_file(&path);
                        }
                        continue;
                    }

                    let target = new_task_dir(project_key, task_id).join("review.json");
                    if dry_run {
                        eprintln!(
                            "  [dry-run] Would migrate review/{}.json → tasks/{}/review.json",
                            task_id, task_id
                        );
                    } else if let Err(e) = ensure_and_move(&path, &target) {
                        eprintln!("  Failed to migrate review for {}: {}", task_id, e);
                        continue;
                    }
                    already_migrated.insert(task_id.to_string());
                    stats.review_migrated += 1;
                }
            }
        }
    }

    // 2. ai/<id>/ (oldest generation)
    let ai_dir = project_dir.join("ai");
    if ai_dir.exists() {
        if let Ok(entries) = fs::read_dir(&ai_dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if !path.is_dir() {
                    continue;
                }
                let task_id = match path.file_name().and_then(|n| n.to_str()) {
                    Some(name) => name.to_string(),
                    None => continue,
                };

                if !known_ids.contains(&task_id) {
                    if dry_run {
                        eprintln!("  [dry-run] Would clean orphan ai dir: ai/{}/", task_id);
                    } else {
                        let _ = fs::remove_dir_all(&path);
                    }
                    stats.orphans_cleaned += 1;
                    continue;
                }

                if already_migrated.contains(&task_id) {
                    if !dry_run {
                        let _ = fs::remove_dir_all(&path);
                    }
                    continue;
                }

                // Try to load comments from ai/<id>/
                let comments = load_legacy_ai_comments(&path);
                if !comments.is_empty() {
                    let target = new_task_dir(project_key, &task_id).join("review.json");
                    let data = CommentsData { comments };
                    if dry_run {
                        eprintln!(
                            "  [dry-run] Would migrate ai/{}/ → tasks/{}/review.json ({} comments)",
                            task_id,
                            task_id,
                            data.comments.len()
                        );
                    } else if let Ok(json) = serde_json::to_string_pretty(&data) {
                        if let Some(parent) = target.parent() {
                            let _ = fs::create_dir_all(parent);
                        }
                        let _ = fs::write(&target, json);
                    }
                    stats.review_migrated += 1;
                }

                // Clean up old ai/<id>/ dir
                if !dry_run {
                    let _ = fs::remove_dir_all(&path);
                }
            }
        }
    }
}

/// Load comments from legacy ai/<task-id>/ directory
fn load_legacy_ai_comments(ai_task_dir: &Path) -> Vec<crate::storage::comments::Comment> {
    // Try comments.json first
    let comments_json = ai_task_dir.join("comments.json");
    if comments_json.exists() {
        if let Ok(content) = fs::read_to_string(&comments_json) {
            if let Ok(data) = serde_json::from_str::<LegacyCommentsData>(&content) {
                return data
                    .comments
                    .into_iter()
                    .map(|c| c.into_new_comment())
                    .collect();
            }
        }
    }

    // Fallback: diff_comments.md + replies.json
    let diff_path = ai_task_dir.join("diff_comments.md");
    let mut comments = if diff_path.exists() {
        fs::read_to_string(&diff_path)
            .map(|content| parse_diff_comments(&content))
            .unwrap_or_default()
    } else {
        Vec::new()
    };

    // Merge replies
    let replies_path = ai_task_dir.join("replies.json");
    let replies = load_replies_file(&replies_path);
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

    comments
}

fn migrate_activity(
    project_key: &str,
    project_dir: &Path,
    known_ids: &HashSet<String>,
    dry_run: bool,
    stats: &mut MigrationStats,
) {
    let activity_dir = project_dir.join("activity");
    if !activity_dir.exists() {
        return;
    }

    let entries = match fs::read_dir(&activity_dir) {
        Ok(e) => e,
        Err(_) => return,
    };

    // Collect already migrated IDs
    let mut already_migrated = HashSet::new();
    let tasks_dir = project_dir.join("tasks");
    if tasks_dir.exists() {
        if let Ok(entries) = fs::read_dir(&tasks_dir) {
            for entry in entries.flatten() {
                if entry.path().join("activity.jsonl").exists() {
                    if let Some(id) = entry.file_name().to_str() {
                        already_migrated.insert(id.to_string());
                    }
                }
            }
        }
    }

    for entry in entries.flatten() {
        let path = entry.path();

        if path.is_file() {
            // activity/<id>.jsonl (mid-generation)
            let file_name = match path.file_name().and_then(|n| n.to_str()) {
                Some(name) => name.to_string(),
                None => continue,
            };

            if let Some(task_id) = file_name.strip_suffix(".jsonl") {
                if !known_ids.contains(task_id) {
                    if dry_run {
                        eprintln!("  [dry-run] Would clean orphan activity: {}", file_name);
                    } else {
                        let _ = fs::remove_file(&path);
                    }
                    stats.orphans_cleaned += 1;
                    continue;
                }

                if already_migrated.contains(task_id) {
                    if !dry_run {
                        let _ = fs::remove_file(&path);
                    }
                    continue;
                }

                let target = new_task_dir(project_key, task_id).join("activity.jsonl");
                if dry_run {
                    eprintln!(
                        "  [dry-run] Would migrate activity/{}.jsonl → tasks/{}/activity.jsonl",
                        task_id, task_id
                    );
                } else if let Err(e) = ensure_and_move(&path, &target) {
                    eprintln!("  Failed to migrate activity for {}: {}", task_id, e);
                    continue;
                }
                already_migrated.insert(task_id.to_string());
                stats.activity_migrated += 1;
            }
        } else if path.is_dir() {
            // activity/<id>/edits.jsonl (oldest generation)
            let task_id = match path.file_name().and_then(|n| n.to_str()) {
                Some(name) => name.to_string(),
                None => continue,
            };

            if !known_ids.contains(&task_id) {
                if dry_run {
                    eprintln!(
                        "  [dry-run] Would clean orphan activity dir: activity/{}/",
                        task_id
                    );
                } else {
                    let _ = fs::remove_dir_all(&path);
                }
                stats.orphans_cleaned += 1;
                continue;
            }

            if already_migrated.contains(&task_id) {
                if !dry_run {
                    let _ = fs::remove_dir_all(&path);
                }
                continue;
            }

            let old_file = path.join("edits.jsonl");
            if old_file.exists() {
                let target = new_task_dir(project_key, &task_id).join("activity.jsonl");
                if dry_run {
                    eprintln!(
                        "  [dry-run] Would migrate activity/{}/edits.jsonl → tasks/{}/activity.jsonl",
                        task_id, task_id
                    );
                } else if let Err(e) = ensure_and_move(&old_file, &target) {
                    eprintln!("  Failed to migrate activity for {}: {}", task_id, e);
                    continue;
                } else {
                    // Remove now-empty dir
                    let _ = fs::remove_dir_all(&path);
                }
                stats.activity_migrated += 1;
            } else {
                // Dir exists but no edits.jsonl, just clean up
                if !dry_run {
                    let _ = fs::remove_dir_all(&path);
                }
            }
        }
    }
}

// ============================================================================
// Helpers
// ============================================================================

fn new_task_dir(project_key: &str, task_id: &str) -> PathBuf {
    storage::grove_dir()
        .join("projects")
        .join(project_key)
        .join("tasks")
        .join(task_id)
}

fn ensure_and_move(src: &Path, dst: &Path) -> std::io::Result<()> {
    if let Some(parent) = dst.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::rename(src, dst).or_else(|_| {
        // Cross-device move: copy + delete
        fs::copy(src, dst)?;
        fs::remove_file(src)
    })
}

fn is_dir_empty_or_has_no_files(dir: &Path) -> bool {
    match fs::read_dir(dir) {
        Ok(entries) => {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_file() {
                    return false;
                }
                if path.is_dir() && !is_dir_empty_or_has_no_files(&path) {
                    return false;
                }
            }
            true
        }
        Err(_) => true,
    }
}

// ============================================================================
// v1.0 → v1.1: task_modes migration
// ============================================================================

/// Migrate to enable_terminal/enable_chat fields for all tasks in a project
/// For tasks without these fields, infer from multiplexer field:
/// - "acp" → enable_terminal=false, enable_chat=true
/// - "tmux" or "zellij" → enable_terminal=true, enable_chat=false
fn migrate_task_modes_v1_1(project_key: &str, dry_run: bool) -> u32 {
    let mut migrated_count = 0u32;

    // Migrate active tasks
    migrated_count += migrate_tasks_file(project_key, "tasks.toml", dry_run);

    // Migrate archived tasks
    migrated_count += migrate_tasks_file(project_key, "archived.toml", dry_run);

    migrated_count
}

fn migrate_tasks_file(project_key: &str, filename: &str, dry_run: bool) -> u32 {
    let project_dir = storage::grove_dir().join("projects").join(project_key);
    let tasks_file = project_dir.join(filename);

    if !tasks_file.exists() {
        return 0;
    }

    let content = match fs::read_to_string(&tasks_file) {
        Ok(c) => c,
        Err(_) => return 0,
    };

    let mut data = match toml::from_str::<toml::Value>(&content) {
        Ok(d) => d,
        Err(_) => return 0,
    };

    let tasks_array = match data.get_mut("tasks").and_then(|t| t.as_array_mut()) {
        Some(arr) => arr,
        None => return 0,
    };

    let mut migrated_count = 0u32;

    for task in tasks_array.iter_mut() {
        let task_table = match task.as_table_mut() {
            Some(t) => t,
            None => continue,
        };

        // Check if already migrated
        if task_table.contains_key("enable_terminal") && task_table.contains_key("enable_chat") {
            // Remove old task_modes field if exists
            task_table.remove("task_modes");
            continue;
        }

        // Get multiplexer field
        let multiplexer = task_table
            .get("multiplexer")
            .and_then(|m| m.as_str())
            .unwrap_or("tmux");

        // Infer from multiplexer
        let (enable_terminal, enable_chat) = match multiplexer {
            "acp" => (false, true),
            _ => (true, false),
        };

        let task_id = task_table
            .get("id")
            .and_then(|id| id.as_str())
            .unwrap_or("unknown");

        if dry_run {
            eprintln!(
                "  [dry-run] Would add enable_terminal={}, enable_chat={} to task {} (multiplexer={})",
                enable_terminal, enable_chat, task_id, multiplexer
            );
        } else {
            // Remove old task_modes field if exists
            task_table.remove("task_modes");
            // Add new fields
            task_table.insert(
                "enable_terminal".to_string(),
                toml::Value::Boolean(enable_terminal),
            );
            task_table.insert("enable_chat".to_string(), toml::Value::Boolean(enable_chat));
        }

        migrated_count += 1;
    }

    // Write back to file
    if !dry_run && migrated_count > 0 {
        if let Ok(new_content) = toml::to_string_pretty(&data) {
            let _ = fs::write(&tasks_file, new_content);
        }
    }

    migrated_count
}

fn update_storage_version(version: &str) -> std::io::Result<()> {
    let config_path = storage::grove_dir().join("config.toml");

    let content = if config_path.exists() {
        fs::read_to_string(&config_path)?
    } else {
        String::new()
    };

    let mut data: toml::Value = if content.is_empty() {
        toml::Value::Table(toml::map::Map::new())
    } else {
        toml::from_str(&content).unwrap_or_else(|_| toml::Value::Table(toml::map::Map::new()))
    };

    if let Some(table) = data.as_table_mut() {
        table.insert(
            "storage_version".to_string(),
            toml::Value::String(version.to_string()),
        );
    }

    let new_content = toml::to_string_pretty(&data).map_err(std::io::Error::other)?;

    fs::write(&config_path, new_content)
}

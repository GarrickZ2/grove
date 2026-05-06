//! Statistics aggregation module
//!
//! `aggregate_range(project_key, from, to)` 直接在日期区间维度聚合，
//! 包含所有"在该区间内活跃过"的任务（active 或生命周期与区间有交叉的 archived）。
//!
//! ## 任务纳入规则
//!
//! 一个任务被纳入统计，当且仅当：
//! - `created_at.date() <= to`（任务在区间结束前已存在）
//! - `archived_at.date() >= from` 或 `status == Active`（任务在区间开始后还活着）
//!
//! ## tasks_completed
//!
//! 只统计 archived_at ∈ [from, to] 的任务，表示"本周期内完成了多少任务"。

use std::collections::{HashMap, HashSet};

use chrono::NaiveDate;
use serde::{Deserialize, Serialize};

use crate::acp::AcpUpdate;
use crate::git;
use crate::storage::chat_history;
use crate::storage::comments::{load_comments, CommentStatus};
use crate::storage::notes;
use crate::storage::tasks::{load_archived_tasks, load_chat_sessions, load_tasks, Task};
use crate::watcher;

// ============================================================================
// Response DTOs (API layer)
// ============================================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BriefDataPoint {
    pub brief_length: u32,
    /// 实际干预次数 = user_messages - active_chat_count（每个 session 的首条消息是任务派发，不算干预）
    pub interventions: u32,
    /// 所有 chat session 的 substantive user messages 总数（>= 5 chars）
    pub user_messages: u32,
    /// AI 执行的 tool calls 总数（工作量指标）
    pub tool_calls: u32,
    /// AI 生成 Plan 的次数（结构化思考指标）
    pub plan_updates: u32,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct HotFile {
    pub path: String,
    pub task_count: u32,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct CommentFlow {
    pub total: u32,
    /// 人开的 comment 数
    pub human_total: u32,
    /// AI 开的 comment 数（review suggestion 采用率）
    pub agent_total: u32,

    // ── 人开的 comment 结果 ───────────────────────────────────────────────
    pub human_resolved: u32,
    pub human_open: u32,
    pub human_outdated: u32,

    // ── AI 开的 comment 结果 ──────────────────────────────────────────────
    pub agent_resolved: u32,
    pub agent_open: u32,
    pub agent_outdated: u32,

    /// 已解决的人的 comment 中，AI 平均回复几轮（effort 指标）
    pub avg_ai_rounds_on_human_comments: f64,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct AgentStat {
    pub agent: String,
    pub display_name: String,
    /// 参与的 task 数
    pub chat_tasks: u32,
    /// 总 tool calls（工作量）
    pub chat_total_tool_calls: u32,
    /// 平均每个 task 的 tool calls
    pub chat_avg_tool_calls_per_task: f64,
    /// AI 开的 review comment 数（建议数量）
    pub review_comments: u32,
    /// AI review 有效率（已解决 / 总数）
    pub review_hit_rate: f64,
    pub contribution_score: f64,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ProjectStatisticsResponse {
    pub time_saved_hours: f64,
    pub parallel_multiplier: f64,
    pub peak_concurrency: u32,
    pub total_active_minutes: u64,
    pub tasks_completed: u32,
    pub tasks_created: u32,
    pub tasks_in_progress: u32,
    pub agent_autonomy_rate: f64,
    pub code_additions: u32,
    pub code_deletions: u32,
    pub avg_files_per_task: f64,
    pub total_files_changed: u32,
    pub avg_brief_length: u32,
    pub avg_interventions_per_task: f64,
    /// 仅含 user_messages > 0 的任务（排除废弃任务）
    pub brief_insight_data: Vec<BriefDataPoint>,
    /// 所有任务的 tool calls 总数
    pub total_tool_calls: u64,
    /// 平均每个活跃任务的 tool calls（仅 user_messages > 0 的任务）
    pub avg_tool_calls_per_task: f64,
    /// 平均每个活跃任务的 plan 更新次数（仅 user_messages > 0 的任务）
    pub avg_plan_updates_per_task: f64,
    pub hot_files: Vec<HotFile>,
    pub comment_flow: CommentFlow,
    pub agent_leaderboard: Vec<AgentStat>,
}

// ============================================================================
// AI agent detection
// ============================================================================

const AI_AGENTS: &[&str] = &["claude", "codex", "gemini", "gpt", "copilot", "o1", "o3"];

fn is_ai_author(author: &str) -> bool {
    let lower = author.to_lowercase();
    AI_AGENTS.iter().any(|a| lower.contains(a))
}

// ============================================================================
// Main entry: aggregate across a date range
// ============================================================================

/// 聚合日期区间 [from, to] 内的统计数据
pub fn aggregate_range(
    project_key: &str,
    from: NaiveDate,
    to: NaiveDate,
) -> ProjectStatisticsResponse {
    // 加载所有任务（active + archived）
    let active_tasks = load_tasks(project_key).unwrap_or_default();
    let archived_tasks = load_archived_tasks(project_key).unwrap_or_default();

    // 筛选：生命周期与 [from, to] 有交叉的任务
    // active:   created_at.date() <= to（在区间结束前已存在）
    // archived: created_at.date() <= to AND archived_at.date() >= from
    let relevant_tasks: Vec<&Task> = active_tasks
        .iter()
        .filter(|t| t.created_at.date_naive() <= to)
        .chain(archived_tasks.iter().filter(|t| {
            let archived_date = t.archived_at.unwrap_or(t.updated_at).date_naive();
            t.created_at.date_naive() <= to && archived_date >= from
        }))
        .collect();

    // tasks_completed：仅统计 archived_at ∈ [from, to] 的任务
    let tasks_completed = archived_tasks
        .iter()
        .filter(|t| {
            let d = t.archived_at.unwrap_or(t.updated_at).date_naive();
            d >= from && d <= to
        })
        .count() as u32;

    // tasks_created：本周期内创建的任务（active + archived，created_at ∈ [from, to]）
    let tasks_created = active_tasks
        .iter()
        .filter(|t| {
            let d = t.created_at.date_naive();
            d >= from && d <= to
        })
        .count() as u32
        + archived_tasks
            .iter()
            .filter(|t| {
                let d = t.created_at.date_naive();
                d >= from && d <= to
            })
            .count() as u32;

    let agent_created = active_tasks
        .iter()
        .filter(|t| {
            let d = t.created_at.date_naive();
            d >= from && d <= to && t.created_by == "agent"
        })
        .count() as u32
        + archived_tasks
            .iter()
            .filter(|t| {
                let d = t.created_at.date_naive();
                d >= from && d <= to && t.created_by == "agent"
            })
            .count() as u32;

    let tasks_in_progress = active_tasks
        .iter()
        .filter(|t| t.created_at.date_naive() <= to)
        .count() as u32;

    // 聚合所有相关任务的详细数据
    aggregate_tasks(
        project_key,
        &relevant_tasks,
        tasks_completed,
        tasks_created,
        tasks_in_progress,
        agent_created,
    )
}

// ============================================================================
// Per-task aggregation
// ============================================================================

#[derive(Default)]
struct RawAgentStat {
    chat_tasks: u32,
    total_tool_calls: u32,
    review_comments: u32,
    resolved_count: u32,
}

fn aggregate_tasks(
    project_key: &str,
    tasks: &[&Task],
    tasks_completed: u32,
    tasks_created: u32,
    tasks_in_progress: u32,
    agent_created: u32,
) -> ProjectStatisticsResponse {
    let mut code_additions: u32 = 0;
    let mut code_deletions: u32 = 0;
    let mut total_files_changed: u32 = 0;
    let mut all_brief_data: Vec<BriefDataPoint> = Vec::new();
    let mut hot_files_map: HashMap<String, HashSet<String>> = HashMap::new();

    // Comment flow accumulators
    let mut cf_human_total: u32 = 0;
    let mut cf_agent_total: u32 = 0;
    let mut cf_human_resolved: u32 = 0;
    let mut cf_human_open: u32 = 0;
    let mut cf_human_outdated: u32 = 0;
    let mut cf_agent_resolved: u32 = 0;
    let mut cf_agent_open: u32 = 0;
    let mut cf_agent_outdated: u32 = 0;
    // AI effort on human comments
    let mut cf_ai_reply_rounds: u32 = 0;
    let mut cf_resolved_human_count: u32 = 0;

    let mut agent_stats: HashMap<String, RawAgentStat> = HashMap::new();

    // 每个 task 的活跃分钟集合（用于并发计算）
    let mut intervals: Vec<std::collections::HashSet<i64>> = Vec::new();

    for task in tasks {
        // ── Code stats ────────────────────────────────────────────────────
        if task.code_additions > 0 || task.code_deletions > 0 || task.files_changed > 0 {
            // Archived task with snapshot — worktree is gone, use the
            // numbers we recorded at archive time.
            code_additions += task.code_additions;
            code_deletions += task.code_deletions;
            total_files_changed += task.files_changed;
        } else if std::path::Path::new(&task.worktree_path).exists() {
            // Active task (or archived without snapshot): compute live.
            if let Ok(entries) = git::diff_stat(&task.worktree_path, &task.target) {
                code_additions += entries.iter().map(|e| e.additions).sum::<u32>();
                code_deletions += entries.iter().map(|e| e.deletions).sum::<u32>();
                total_files_changed += entries.len() as u32;
            }
        }

        // ── Brief data (notes char count) ────────────────────────────────
        let notes_content = notes::load_notes(project_key, &task.id).unwrap_or_default();
        let brief_length = notes_content.chars().count() as u32;

        // ── Hot files ─────────────────────────────────────────────────────
        let edits = watcher::load_edit_history(project_key, &task.id).unwrap_or_default();
        for event in &edits {
            let path = event.file.to_string_lossy().to_string();
            hot_files_map
                .entry(path)
                .or_default()
                .insert(task.id.clone());
        }

        // ── Comment flow ──────────────────────────────────────────────────
        let comments_data = load_comments(project_key, &task.id).unwrap_or_default();
        for comment in &comments_data.comments {
            let ai = is_ai_author(&comment.agent);
            if ai {
                cf_agent_total += 1;
            } else {
                cf_human_total += 1;
            }

            match comment.status {
                CommentStatus::Open => {
                    if ai {
                        cf_agent_open += 1;
                    } else {
                        cf_human_open += 1;
                    }
                }
                CommentStatus::Resolved => {
                    if ai {
                        cf_agent_resolved += 1;
                    } else {
                        cf_human_resolved += 1;
                        // 统计 AI 为解决这条人的 comment 花了几轮回复
                        let ai_reply_count = comment
                            .replies
                            .iter()
                            .filter(|r| is_ai_author(&r.agent))
                            .count() as u32;
                        cf_ai_reply_rounds += ai_reply_count;
                        cf_resolved_human_count += 1;
                    }
                }
                CommentStatus::Outdated => {
                    if ai {
                        cf_agent_outdated += 1;
                    } else {
                        cf_human_outdated += 1;
                    }
                }
            }
        }

        // ── Chat sessions + history（单次遍历，跳过空 chat）──────────────────
        // 空 chat = history.jsonl 中没有任何事件，不计入 session 数和 agent stats。
        // user_messages = 长度 >= 5 Unicode 字符的 UserMessage（中英文通用）
        // interventions = user_messages - active_chat_count
        //   （每个 session 的首条消息是任务派发，不算干预；后续消息才算）
        // 0 user_messages 的任务视为废弃任务，不纳入 brief_insight_data。
        let chats = load_chat_sessions(project_key, &task.id).unwrap_or_default();
        let mut user_message_count: u32 = 0;
        let mut active_chat_count: u32 = 0;
        let mut task_tool_calls: u32 = 0;
        let mut task_plan_updates: u32 = 0;
        let mut task_active_minutes: std::collections::HashSet<i64> =
            std::collections::HashSet::new();

        for event in &edits {
            task_active_minutes.insert(event.timestamp.timestamp() / 60);
        }

        for chat in &chats {
            let key = chat.agent.to_lowercase();
            let has_key = !key.is_empty();
            let mut chat_had_events = false;

            // 使用 canonical key 聚合同类 agent（如 "claude code (planner)" → "claude"）
            let canonical_key = canonical_agent(&key);

            for event in chat_history::load_history(project_key, &task.id, &chat.id) {
                if !chat_had_events {
                    chat_had_events = true;
                    active_chat_count += 1;
                    if has_key {
                        agent_stats
                            .entry(canonical_key.clone())
                            .or_default()
                            .chat_tasks += 1;
                    }
                }
                match &event {
                    AcpUpdate::UserMessage { text, .. } if text.trim().chars().count() >= 5 => {
                        user_message_count += 1;
                    }
                    AcpUpdate::ToolCall { timestamp, .. } => {
                        task_tool_calls += 1;
                        if has_key {
                            agent_stats
                                .entry(canonical_key.clone())
                                .or_default()
                                .total_tool_calls += 1;
                        }
                        if let Some(ts) = timestamp {
                            task_active_minutes.insert(ts.timestamp() / 60);
                        }
                    }
                    AcpUpdate::PlanUpdate { .. } => {
                        task_plan_updates += 1;
                    }
                    _ => {}
                }
            }
        }

        // 0 user_messages = 废弃任务，不纳入 brief_insight_data
        if user_message_count > 0 {
            let interventions = user_message_count.saturating_sub(active_chat_count);
            all_brief_data.push(BriefDataPoint {
                brief_length,
                interventions,
                user_messages: user_message_count,
                tool_calls: task_tool_calls,
                plan_updates: task_plan_updates,
            });
        }

        // ── Agent review comments（同样用 canonical key 聚合）────────────────
        for comment in &comments_data.comments {
            if !is_ai_author(&comment.agent) {
                continue;
            }
            let key = canonical_agent(&comment.agent);
            let entry = agent_stats.entry(key).or_default();
            entry.review_comments += 1;
            if matches!(comment.status, CommentStatus::Resolved) {
                entry.resolved_count += 1;
            }
        }

        intervals.push(task_active_minutes);
    }

    // ── Derived metrics ────────────────────────────────────────────────────
    let total_tasks = tasks.len() as u32;
    // 活跃任务数（user_messages > 0，排除废弃任务）
    let n_active = all_brief_data.len() as f64;

    let agent_autonomy_rate = if tasks_created > 0 {
        agent_created as f64 / tasks_created as f64
    } else {
        0.0
    };

    let avg_files_per_task = if total_tasks > 0 {
        (total_files_changed as f64 / total_tasks as f64 * 10.0).round() / 10.0
    } else {
        0.0
    };

    let avg_brief_length = if all_brief_data.is_empty() {
        0
    } else {
        (all_brief_data
            .iter()
            .map(|d| d.brief_length as u64)
            .sum::<u64>()
            / all_brief_data.len() as u64) as u32
    };

    let avg_interventions = if n_active > 0.0 {
        all_brief_data
            .iter()
            .map(|d| d.interventions as f64)
            .sum::<f64>()
            / n_active
    } else {
        0.0
    };

    // tool calls & plan updates（仅活跃任务）
    let total_tool_calls: u64 = all_brief_data.iter().map(|d| d.tool_calls as u64).sum();
    let avg_tool_calls_per_task = if n_active > 0.0 {
        total_tool_calls as f64 / n_active
    } else {
        0.0
    };
    let avg_plan_updates_per_task = if n_active > 0.0 {
        all_brief_data
            .iter()
            .map(|d| d.plan_updates as f64)
            .sum::<f64>()
            / n_active
    } else {
        0.0
    };

    // ── 并发统计（基于实际 activity 分钟）────────────────────────────────────
    // minute_count[m] = 该分钟有多少个 task 同时活跃
    let mut minute_count: HashMap<i64, u32> = HashMap::new();
    let mut total_active_minutes: u64 = 0;

    for task_minutes in &intervals {
        total_active_minutes += task_minutes.len() as u64;
        for &m in task_minutes {
            *minute_count.entry(m).or_insert(0) += 1;
        }
    }

    let mut time_saved_minutes: u64 = 0;
    let mut peak_concurrency: u32 = 0;

    for &count in minute_count.values() {
        if count > peak_concurrency {
            peak_concurrency = count;
        }
        if count >= 2 {
            time_saved_minutes += (count - 1) as u64;
        }
    }

    let parallel_multiplier = if total_active_minutes > time_saved_minutes
        && total_active_minutes > 0
    {
        (total_active_minutes as f64 / (total_active_minutes - time_saved_minutes) as f64).max(1.0)
    } else {
        1.0
    };

    let time_saved_hours = if parallel_multiplier >= 1.005 {
        time_saved_minutes as f64 / 60.0
    } else {
        0.0
    };

    // ── Hot files (top 6) ──────────────────────────────────────────────────
    let mut hot_files: Vec<HotFile> = hot_files_map
        .into_iter()
        .map(|(path, set)| HotFile {
            path,
            task_count: set.len() as u32,
        })
        .collect();
    hot_files.sort_by_key(|b| std::cmp::Reverse(b.task_count));
    hot_files.truncate(6);

    // ── Agent leaderboard ──────────────────────────────────────────────────
    let mut leaderboard: Vec<AgentStat> = agent_stats
        .into_iter()
        .map(|(agent, raw)| {
            let avg_tool_calls_per_task = if raw.chat_tasks > 0 {
                raw.total_tool_calls as f64 / raw.chat_tasks as f64
            } else {
                0.0
            };
            let hit_rate = if raw.review_comments > 0 {
                raw.resolved_count as f64 / raw.review_comments as f64
            } else {
                0.0
            };

            let mut s = AgentStat {
                display_name: display_name(&agent),
                agent,
                chat_tasks: raw.chat_tasks,
                chat_total_tool_calls: raw.total_tool_calls,
                chat_avg_tool_calls_per_task: (avg_tool_calls_per_task * 10.0).round() / 10.0,
                review_comments: raw.review_comments,
                review_hit_rate: (hit_rate * 1000.0).round() / 1000.0,
                contribution_score: 0.0,
            };
            s.contribution_score = compute_contribution_score(&s);
            s
        })
        .collect();
    leaderboard.sort_by(|a, b| {
        b.contribution_score
            .partial_cmp(&a.contribution_score)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    ProjectStatisticsResponse {
        time_saved_hours: (time_saved_hours * 100.0).round() / 100.0,
        parallel_multiplier: (parallel_multiplier * 100.0).round() / 100.0,
        peak_concurrency,
        total_active_minutes,
        tasks_completed,
        tasks_created,
        tasks_in_progress,
        agent_autonomy_rate: (agent_autonomy_rate * 1000.0).round() / 1000.0,
        code_additions,
        code_deletions,
        avg_files_per_task,
        total_files_changed,
        avg_brief_length,
        avg_interventions_per_task: (avg_interventions * 10.0).round() / 10.0,
        brief_insight_data: all_brief_data,
        total_tool_calls,
        avg_tool_calls_per_task: (avg_tool_calls_per_task * 10.0).round() / 10.0,
        avg_plan_updates_per_task: (avg_plan_updates_per_task * 10.0).round() / 10.0,
        hot_files,
        comment_flow: CommentFlow {
            total: cf_human_total + cf_agent_total,
            human_total: cf_human_total,
            agent_total: cf_agent_total,
            human_resolved: cf_human_resolved,
            human_open: cf_human_open,
            human_outdated: cf_human_outdated,
            agent_resolved: cf_agent_resolved,
            agent_open: cf_agent_open,
            agent_outdated: cf_agent_outdated,
            avg_ai_rounds_on_human_comments: if cf_resolved_human_count > 0 {
                (cf_ai_reply_rounds as f64 / cf_resolved_human_count as f64 * 10.0).round() / 10.0
            } else {
                0.0
            },
        },
        agent_leaderboard: leaderboard,
    }
}

// ============================================================================
// Helpers
// ============================================================================

/// 将 agent 名字归一化到已知的 AI agent 基础名。
/// "Claude code (planner)" / "claude code (reviewer)" → "claude"
/// 未识别的保留原始小写名。
fn canonical_agent(name: &str) -> String {
    let lower = name.to_lowercase();
    for &known in AI_AGENTS {
        if lower.contains(known) {
            return known.to_string();
        }
    }
    lower.trim().to_string()
}

fn display_name(agent: &str) -> String {
    match agent {
        "claude" => "Claude Code".to_string(),
        "codex" => "Codex".to_string(),
        "gemini" => "Gemini".to_string(),
        "gpt" => "GPT".to_string(),
        "copilot" => "GitHub Copilot".to_string(),
        "o1" => "o1".to_string(),
        "o3" => "o3".to_string(),
        other => {
            let mut s = other.to_string();
            if let Some(first) = s.get_mut(0..1) {
                first.make_ascii_uppercase();
            }
            s
        }
    }
}

fn compute_contribution_score(a: &AgentStat) -> f64 {
    // 工作量：tool calls（最重要）
    let tool_score = (a.chat_total_tool_calls as f64 / 10.0).min(100.0);
    // 参与任务数
    let task_score = (a.chat_tasks as f64 * 5.0).min(100.0);
    // Review 质量：有建议且有效率高
    let review_score = if a.review_comments > 0 {
        a.review_hit_rate * 100.0
    } else {
        0.0
    };
    (tool_score * 0.5 + task_score * 0.3 + review_score * 0.2).min(100.0)
}

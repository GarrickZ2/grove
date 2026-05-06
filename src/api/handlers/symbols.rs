//! Symbol API handlers: cmd+click navigation and symbol search.

use axum::{
    extract::{Path, Query},
    http::StatusCode,
    Json,
};
use serde::{Deserialize, Serialize};

use crate::model::loader;
use crate::storage::{tasks, workspace};
use crate::symbols::{self, SymbolDef, SymbolKind};

use super::common;

// ============================================================================
// Response DTOs
// ============================================================================

#[derive(Debug, Serialize)]
pub struct CandidateResponse {
    pub name: String,
    pub kind: &'static str,
    pub file_path: String,
    pub line: u32,
    pub col: u32,
    pub end_line: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub container: Option<String>,
    pub language: &'static str,
}

#[derive(Debug, Serialize)]
pub struct LookupResponse {
    pub candidates: Vec<CandidateResponse>,
}

// ============================================================================
// Request DTOs
// ============================================================================

#[derive(Debug, Deserialize)]
pub struct LookupParams {
    /// Symbol identifier the user clicked.
    pub name: String,
    /// Source file the click happened in (relative to worktree, forward
    /// slashes). Used to rank same-file candidates above others.
    #[serde(default)]
    pub from_file: Option<String>,
    /// 0-indexed line of the click. Used as a tiebreaker among
    /// same-file candidates (closest definition wins).
    #[serde(default)]
    pub from_line: Option<u32>,
}

#[derive(Debug, Deserialize)]
pub struct SearchParams {
    pub q: String,
    #[serde(default)]
    pub limit: Option<usize>,
}

// ============================================================================
// Handlers
// ============================================================================

/// GET /api/v1/projects/{id}/tasks/{taskId}/symbols/lookup?name=...&from_file=...&from_line=...
///
/// Pure read. Does not block on the build pipeline — if the index
/// hasn't finished building yet, returns whatever rows are persisted
/// so far (possibly empty). Caller retries.
pub async fn lookup_symbol(
    Path((id, task_id)): Path<(String, String)>,
    Query(params): Query<LookupParams>,
) -> Result<Json<LookupResponse>, StatusCode> {
    let (_, project_key) = common::find_project_by_id(&id)?;

    let mut hits = symbols::lookup(&project_key, &task_id, &params.name)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    rank_candidates(&mut hits, params.from_file.as_deref(), params.from_line);

    Ok(Json(LookupResponse {
        candidates: hits.into_iter().map(into_candidate).collect(),
    }))
}

/// GET /api/v1/projects/{id}/tasks/{taskId}/symbols/search?q=...&limit=...
pub async fn search_symbols(
    Path((id, task_id)): Path<(String, String)>,
    Query(params): Query<SearchParams>,
) -> Result<Json<LookupResponse>, StatusCode> {
    let (_, project_key) = common::find_project_by_id(&id)?;
    let limit = params.limit.unwrap_or(50).min(500);
    let hits = symbols::search(&project_key, &task_id, &params.q, limit)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    Ok(Json(LookupResponse {
        candidates: hits.into_iter().map(into_candidate).collect(),
    }))
}

/// POST /api/v1/projects/{id}/tasks/{taskId}/symbols/reindex
///
/// Force a from-scratch rebuild. Drops cached rows so the build can't
/// mtime-skip them, then queues a debounced reindex. Returns
/// immediately — the build runs in the background.
pub async fn reindex_symbols(
    Path((id, task_id)): Path<(String, String)>,
) -> Result<StatusCode, StatusCode> {
    let Some((project_key, worktree)) = resolve_active_worktree(&id, &task_id).await? else {
        return Ok(StatusCode::NO_CONTENT);
    };
    symbols::trigger_reindex(&project_key, &task_id, std::path::Path::new(&worktree));
    Ok(StatusCode::NO_CONTENT)
}

// ============================================================================
// Helpers
// ============================================================================

fn into_candidate(s: SymbolDef) -> CandidateResponse {
    CandidateResponse {
        name: s.name,
        kind: kind_str(s.kind),
        file_path: s.file_path,
        line: s.line,
        col: s.col,
        end_line: s.end_line,
        container: s.container,
        language: s.language.as_str(),
    }
}

fn kind_str(k: SymbolKind) -> &'static str {
    k.as_str()
}

/// Resolve `(project_id, task_id)` to `(project_key, worktree_path)` if
/// the task is active (not archived) and the path exists. Returns
/// `None` for archived tasks, missing paths, or the LOCAL_TASK_ID
/// pseudo-task.
async fn resolve_active_worktree(
    id: &str,
    task_id: &str,
) -> Result<Option<(String, String)>, StatusCode> {
    if task_id == tasks::LOCAL_TASK_ID {
        return Ok(None);
    }

    let (project, project_key) = common::find_project_by_id(id)?;
    let is_studio = project.project_type == workspace::ProjectType::Studio;
    let project_path = project.path.clone();
    let pk_for_blocking = project_key.clone();
    let tid = task_id.to_string();

    let path: Option<String> = tokio::task::spawn_blocking(move || {
        if is_studio {
            tasks::get_task(&pk_for_blocking, &tid)
                .ok()
                .flatten()
                .map(|t| t.worktree_path)
        } else {
            loader::load_worktrees(&project_path)
                .iter()
                .find(|wt| wt.id == tid)
                .map(|wt| wt.path.clone())
        }
    })
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    let Some(p) = path else {
        return Ok(None);
    };
    if !std::path::Path::new(&p).exists() {
        return Ok(None);
    }
    Ok(Some((project_key, p)))
}

/// Rank candidates so the most likely intended definition comes first.
///
/// Order:
///   1. Same file as the click site, closest line first.
///   2. Other files, sorted by file path for stability.
///
/// Language-family ranking will become relevant when we add a second
/// grammar; for now there's only Go.
fn rank_candidates(hits: &mut [SymbolDef], from_file: Option<&str>, from_line: Option<u32>) {
    hits.sort_by(|a, b| {
        let a_same = from_file.map(|f| a.file_path == f).unwrap_or(false);
        let b_same = from_file.map(|f| b.file_path == f).unwrap_or(false);
        match (a_same, b_same) {
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            (true, true) => {
                let line = from_line.unwrap_or(0) as i64;
                let da = (a.line as i64 - line).abs();
                let db = (b.line as i64 - line).abs();
                da.cmp(&db)
            }
            (false, false) => a.file_path.cmp(&b.file_path),
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::symbols::Language;

    fn sym(name: &str, file: &str, line: u32) -> SymbolDef {
        SymbolDef {
            name: name.into(),
            kind: SymbolKind::Function,
            file_path: file.into(),
            line,
            col: 0,
            end_line: line + 2,
            container: None,
            language: Language::Go,
        }
    }

    #[test]
    fn rank_prefers_same_file_then_closest_line() {
        let mut hits = vec![
            sym("Foo", "z.go", 10),
            sym("Foo", "src/a.go", 100),
            sym("Foo", "src/a.go", 50),
            sym("Foo", "x.go", 5),
        ];
        rank_candidates(&mut hits, Some("src/a.go"), Some(60));
        assert_eq!(hits[0].file_path, "src/a.go");
        assert_eq!(hits[0].line, 50, "closest same-file line wins first");
        assert_eq!(hits[1].file_path, "src/a.go");
        assert_eq!(hits[1].line, 100);
        // Remaining ordered alphabetically by file path.
        assert_eq!(hits[2].file_path, "x.go");
        assert_eq!(hits[3].file_path, "z.go");
    }

    #[test]
    fn rank_with_no_origin_sorts_alphabetically() {
        let mut hits = vec![
            sym("Foo", "z.go", 10),
            sym("Foo", "a.go", 5),
            sym("Foo", "m.go", 20),
        ];
        rank_candidates(&mut hits, None, None);
        let paths: Vec<&str> = hits.iter().map(|s| s.file_path.as_str()).collect();
        assert_eq!(paths, vec!["a.go", "m.go", "z.go"]);
    }
}

//! REST handlers for Studio task designs (HTML pages on a board).

use std::sync::Arc;

use axum::{
    extract::{Path, Query, State},
    http::{header, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::api::auth::ServerAuth;
use crate::error::GroveError;
use crate::storage::{comments, design_transfer, designs, workspace};

use super::super::common::find_project_by_id;
use super::crud::get_git_user_name;

type Failure = (StatusCode, String);

fn failure(error: GroveError) -> Failure {
    match error {
        GroveError::Storage(message) => {
            let status =
                if message == designs::CHANGED_SINCE || message == design_transfer::SYSTEM_EXISTS {
                    StatusCode::CONFLICT
                } else if message.contains("not found") {
                    StatusCode::NOT_FOUND
                } else {
                    StatusCode::BAD_REQUEST
                };
            (status, message)
        }
        other => {
            eprintln!("[designs] {other}");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                "internal server error".to_string(),
            )
        }
    }
}

/// Designs belong to Studio tasks.
fn studio_project(id: &str) -> Result<String, Failure> {
    let (project, key) = find_project_by_id(id).map_err(|status| {
        (
            status,
            status.canonical_reason().unwrap_or("failed").to_string(),
        )
    })?;
    if project.project_type != workspace::ProjectType::Studio {
        return Err((
            StatusCode::NOT_FOUND,
            "designs are part of Studio tasks".to_string(),
        ));
    }
    Ok(key)
}

#[derive(Debug, Deserialize, Default)]
pub struct ListQuery {
    /// Set by the Design panel: says a window is showing the designs, and
    /// makes `design/` with its link to the design system.
    #[serde(default)]
    watch: bool,
}

/// GET /projects/{id}/tasks/{taskId}/designs
pub async fn list_designs(
    Path((id, task_id)): Path<(String, String)>,
    Query(query): Query<ListQuery>,
) -> Result<Json<Value>, Failure> {
    let project = studio_project(&id)?;
    if query.watch {
        designs::ensure_root(&project, &task_id).map_err(failure)?;
        designs::touch_viewer(&project, &task_id).map_err(failure)?;
    }
    let list = designs::list_designs(&project, &task_id).map_err(failure)?;
    Ok(Json(json!({ "designs": list })))
}

#[derive(Debug, Deserialize, Default)]
pub struct LayoutRequest {
    #[serde(default)]
    pages: Vec<designs::PageChange>,
    #[serde(default)]
    labels: Vec<designs::LabelChange>,
}

/// PATCH /projects/{id}/tasks/{taskId}/designs/{design}/layout
pub async fn update_design_layout(
    Path((id, task_id, slug)): Path<(String, String, String)>,
    Json(request): Json<LayoutRequest>,
) -> Result<StatusCode, Failure> {
    let project = studio_project(&id)?;
    designs::update_layout(&project, &task_id, &slug, &request.pages, &request.labels)
        .map_err(failure)?;
    Ok(StatusCode::NO_CONTENT)
}

/// GET /projects/{id}/tasks/{taskId}/designs/{design}/pages/{file}
///
/// The page's HTML as text. The panel puts it in a sandboxed frame itself;
/// this response is never something a browser runs.
pub async fn get_design_page(
    Path((id, task_id, slug, file)): Path<(String, String, String, String)>,
) -> Result<Response, Failure> {
    let project = studio_project(&id)?;
    let html = designs::read_page(&project, &task_id, &slug, &file).map_err(failure)?;
    Ok(plain_text(html))
}

/// PUT /projects/{id}/tasks/{taskId}/designs/{design}/pages/{file}
///
/// The page's HTML after an edit made in the Design panel.
pub async fn update_design_page(
    Path((id, task_id, slug, file)): Path<(String, String, String, String)>,
    Json(body): Json<PageBody>,
) -> Result<Json<serde_json::Value>, Failure> {
    let project = studio_project(&id)?;
    designs::write_page(
        &project,
        &task_id,
        &slug,
        &file,
        &body.html,
        body.expect.as_deref(),
    )
    .map_err(failure)?;
    Ok(Json(serde_json::json!({})))
}

/// The design comments a visitor sees: all of them, the owner's and the
/// agent's answers included, so the board reads the same on both sides.
pub fn shared_design_comments(project: &str, task_id: &str) -> Vec<DesignComment> {
    design_comments(project, task_id).unwrap_or_default()
}

#[derive(Debug, Deserialize)]
pub struct PageBody {
    pub html: String,
    /// What the panel read before changing it; the write is refused when the
    /// file holds something else by now.
    #[serde(default)]
    pub expect: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct MarksBody {
    pub marks: Vec<Value>,
}

/// PUT /projects/{id}/tasks/{taskId}/designs/{design}/marks — what the user
/// drew and wrote on the board.
pub async fn update_design_marks(
    Path((id, task_id, slug)): Path<(String, String, String)>,
    Json(body): Json<MarksBody>,
) -> Result<Json<Value>, Failure> {
    let project = studio_project(&id)?;
    designs::set_marks(&project, &task_id, &slug, body.marks).map_err(failure)?;
    Ok(Json(json!({})))
}

#[derive(Debug, Deserialize)]
pub struct FrameBody {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// POST /projects/{id}/tasks/{taskId}/designs/{design}/pages — an empty page
/// where the user drew a frame.
pub async fn create_design_page(
    Path((id, task_id, slug)): Path<(String, String, String)>,
    Json(body): Json<FrameBody>,
) -> Result<Json<Value>, Failure> {
    let project = studio_project(&id)?;
    let file = designs::create_page(
        &project,
        &task_id,
        &slug,
        body.x,
        body.y,
        body.width,
        body.height,
    )
    .map_err(failure)?;
    Ok(Json(json!({ "file": file })))
}

#[derive(Debug, Deserialize)]
pub struct StyleBody {
    /// Path under `design/`.
    pub path: String,
    pub css: String,
    #[serde(default)]
    pub expect: Option<String>,
}

/// PUT /projects/{id}/tasks/{taskId}/designs/styles — a stylesheet after the
/// user changed one of its variables.
pub async fn update_design_style(
    Path((id, task_id)): Path<(String, String)>,
    Json(body): Json<StyleBody>,
) -> Result<Json<Value>, Failure> {
    let project = studio_project(&id)?;
    designs::write_style(
        &project,
        &task_id,
        &body.path,
        &body.css,
        body.expect.as_deref(),
    )
    .map_err(failure)?;
    Ok(Json(json!({})))
}

// ─── In and out ──────────────────────────────────────────────────────────────

fn download(content_type: &str, name: &str, body: axum::body::Body) -> Response {
    (
        [
            (header::CONTENT_TYPE, content_type.to_string()),
            (
                header::CONTENT_DISPOSITION,
                super::artifact_zip::attachment_disposition(name),
            ),
            (header::CACHE_CONTROL, "no-store".to_string()),
            (header::X_CONTENT_TYPE_OPTIONS, "nosniff".to_string()),
        ],
        body,
    )
        .into_response()
}

fn blocking_failed(_: tokio::task::JoinError) -> Failure {
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        "internal server error".to_string(),
    )
}

/// GET /projects/{id}/tasks/{taskId}/designs/{design}/export
///
/// The design as a zip of its files, the design system beside it.
pub async fn export_design(
    Path((id, task_id, slug)): Path<(String, String, String)>,
) -> Result<Response, Failure> {
    use super::artifact_zip::{write_zip, ZipItem};
    use std::io::{Seek, SeekFrom};

    let (found, project) =
        find_project_by_id(&id).map_err(|status| (status, "project not found".to_string()))?;
    studio_project(&id)?;
    let name = if slug == designs::SYSTEM {
        format!("{}-design-system.zip", found.name)
    } else {
        format!("{slug}.zip")
    };
    let file = tokio::task::spawn_blocking(move || -> Result<std::fs::File, Failure> {
        let items: Vec<ZipItem> = design_transfer::export_files(&project, &task_id, &slug)
            .map_err(failure)?
            .into_iter()
            .map(|file| ZipItem {
                source: file.source,
                name: file.name,
                is_dir: false,
                size: file.size,
            })
            .collect();
        let failed = |_| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                "the archive could not be made".to_string(),
            )
        };
        let mut file = write_zip(&items, tempfile::tempfile().map_err(failed)?).map_err(failed)?;
        file.seek(SeekFrom::Start(0)).map_err(failed)?;
        Ok(file)
    })
    .await
    .map_err(blocking_failed)??;
    let body = axum::body::Body::from_stream(tokio_util::io::ReaderStream::new(
        tokio::fs::File::from_std(file),
    ));
    Ok(download("application/zip", &name, body))
}

#[derive(Debug, Deserialize)]
pub struct PageExportQuery {
    /// `html`: the page with its files inside it. `png`: the image the panel
    /// last rendered of it.
    format: String,
}

/// GET /projects/{id}/tasks/{taskId}/designs/{design}/pages/{file}/export?format=html|png
pub async fn export_design_page(
    Path((id, task_id, slug, file)): Path<(String, String, String, String)>,
    Query(query): Query<PageExportQuery>,
) -> Result<Response, Failure> {
    let project = studio_project(&id)?;
    let stem = file
        .rsplit_once('.')
        .map_or(file.as_str(), |(stem, _)| stem);
    match query.format.as_str() {
        "html" => {
            let name = format!("{slug}-{stem}.html");
            let html = tokio::task::spawn_blocking(move || {
                design_transfer::standalone_page(&project, &task_id, &slug, &file)
            })
            .await
            .map_err(blocking_failed)?
            .map_err(failure)?;
            Ok(download("text/html; charset=utf-8", &name, html.into()))
        }
        "png" => {
            let png = designs::load_capture(&project, &task_id, &slug, &file)
                .map_err(failure)?
                .and_then(|capture| capture.png)
                .ok_or((
                    StatusCode::NOT_FOUND,
                    "the page has no image yet".to_string(),
                ))?;
            Ok(download(
                "image/png",
                &format!("{slug}-{stem}.png"),
                png.into(),
            ))
        }
        _ => Err((
            StatusCode::BAD_REQUEST,
            "format must be html or png".to_string(),
        )),
    }
}

#[derive(Debug, Deserialize, Default)]
pub struct ImportQuery {
    /// What to do with a design system the zip brings when the Project has
    /// one: `skip` or `overwrite`. Without it such an import is refused (409)
    /// and nothing is written, so the panel can ask.
    system: Option<String>,
}

/// POST /projects/{id}/tasks/{taskId}/designs/import — a zip of designs, a
/// design system, or both.
pub async fn import_design(
    Path((id, task_id)): Path<(String, String)>,
    Query(query): Query<ImportQuery>,
    mut multipart: axum::extract::Multipart,
) -> Result<Json<Value>, Failure> {
    let project = studio_project(&id)?;
    let choice = match query.system.as_deref() {
        None => design_transfer::SystemChoice::Ask,
        Some("skip") => design_transfer::SystemChoice::Skip,
        Some("overwrite") => design_transfer::SystemChoice::Overwrite,
        Some(_) => {
            return Err((
                StatusCode::BAD_REQUEST,
                "system must be skip or overwrite".to_string(),
            ))
        }
    };
    let unreadable = |_| {
        (
            StatusCode::BAD_REQUEST,
            "the upload could not be read".to_string(),
        )
    };
    let field = multipart.next_field().await.map_err(unreadable)?.ok_or((
        StatusCode::BAD_REQUEST,
        "a zip file is required".to_string(),
    ))?;
    let name = field.file_name().unwrap_or("design.zip").to_string();
    let bytes = field.bytes().await.map_err(unreadable)?;
    let imported = tokio::task::spawn_blocking(move || {
        design_transfer::import_zip(&project, &task_id, &name, &bytes, choice)
    })
    .await
    .map_err(blocking_failed)?
    .map_err(failure)?;
    Ok(Json(json!(imported)))
}

/// GET /projects/{id}/tasks/{taskId}/designs/guide — the design system's DESIGN.md.
pub async fn get_design_guide(
    Path((id, task_id)): Path<(String, String)>,
) -> Result<Response, Failure> {
    let project = studio_project(&id)?;
    let guide = designs::read_guide(&project, &task_id)
        .map_err(failure)?
        .ok_or((StatusCode::NOT_FOUND, "no DESIGN.md".to_string()))?;
    Ok(plain_text(guide))
}

fn plain_text(body: String) -> Response {
    (
        [
            (header::CONTENT_TYPE, "text/plain; charset=utf-8"),
            (header::CACHE_CONTROL, "no-store"),
            (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
        ],
        body,
    )
        .into_response()
}

#[derive(Debug, Deserialize)]
pub struct CaptureRequest {
    /// The page `version` the render was made from.
    version: String,
    /// PNG, base64. Left out when the page could not be drawn.
    #[serde(default)]
    image: Option<String>,
    /// The page check: what overflows, overlaps, failed to load.
    #[serde(default)]
    report: Value,
}

const PNG_SIGNATURE: [u8; 8] = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];

/// POST /projects/{id}/tasks/{taskId}/designs/{design}/pages/{file}/capture
///
/// What the panel rendered, for the agent to read back with `design_read`.
pub async fn upload_design_capture(
    Path((id, task_id, slug, file)): Path<(String, String, String, String)>,
    Json(request): Json<CaptureRequest>,
) -> Result<StatusCode, Failure> {
    use base64::Engine;
    let project = studio_project(&id)?;
    let png = match request.image.as_deref() {
        Some(encoded) => {
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(encoded)
                .map_err(|_| (StatusCode::BAD_REQUEST, "image is not base64".to_string()))?;
            if !bytes.starts_with(&PNG_SIGNATURE) {
                return Err((StatusCode::BAD_REQUEST, "image is not a PNG".to_string()));
            }
            Some(bytes)
        }
        None => None,
    };
    designs::save_capture(
        &project,
        &task_id,
        &slug,
        &file,
        &request.version,
        png.as_deref(),
        &request.report,
    )
    .map_err(failure)?;
    Ok(StatusCode::NO_CONTENT)
}

// ─── Files pages load ────────────────────────────────────────────────────────

fn file_scope(project: &str, task_id: &str) -> String {
    // NUL never appears in a plugin id, so this cannot collide with one.
    format!("design\0{project}\0{task_id}")
}

/// POST /projects/{id}/tasks/{taskId}/designs/session
///
/// A page's styles, images and scripts are fetched by the browser from inside
/// a sandboxed frame, which cannot sign requests. After the usual sign-in
/// check this hands out a path capability for this one task's `design/`.
pub async fn create_design_session(
    State(auth): State<Arc<ServerAuth>>,
    axum::Extension(identity): axum::Extension<crate::api::device_auth::RequestAuth>,
    Path((id, task_id)): Path<(String, String)>,
) -> Result<Json<Value>, Failure> {
    let project = studio_project(&id)?;
    let scope = file_scope(&project, &task_id);
    let token = identity
        .id()
        .map(|device| auth.plugin_device_asset_token(&scope, device))
        .unwrap_or_else(|| auth.plugin_asset_token(&scope));
    Ok(Json(json!({ "token": token })))
}

/// GET /design-files/{token}/{project}/{task}/{*path}
///
/// Read-only files under the task's `design/`. Relative URLs in a page keep
/// the token because it sits in the path.
pub async fn serve_design_file(
    State(auth): State<Arc<ServerAuth>>,
    Path((token, project, task_id, path)): Path<(String, String, String, String)>,
) -> Result<Response, Failure> {
    if !auth.verify_plugin_asset_token(&file_scope(&project, &task_id), &token) {
        return Err((
            StatusCode::UNAUTHORIZED,
            "design session required".to_string(),
        ));
    }
    design_file(&project, &task_id, &path)
}

// ─── The Project's design system, without a task ─────────────────────────────

fn system_scope(project: &str) -> String {
    format!("design-system\0{project}")
}

/// GET /projects/{id}/design-system
///
/// The Project's design system as a board to look at, and the path capability
/// its pages load their files with. `design` is null when there is none yet.
pub async fn get_design_system(
    State(auth): State<Arc<ServerAuth>>,
    axum::Extension(identity): axum::Extension<crate::api::device_auth::RequestAuth>,
    Path(id): Path<String>,
) -> Result<Json<Value>, Failure> {
    let project = studio_project(&id)?;
    let scope = system_scope(&project);
    let token = identity
        .id()
        .map(|device| auth.plugin_device_asset_token(&scope, device))
        .unwrap_or_else(|| auth.plugin_asset_token(&scope));
    let design = designs::project_system(&project).map_err(failure)?;
    Ok(Json(
        json!({ "design": design, "token": token, "project": project }),
    ))
}

/// GET /projects/{id}/design-system/pages/{file}
pub async fn get_design_system_page(
    Path((id, file)): Path<(String, String)>,
) -> Result<Response, Failure> {
    let project = studio_project(&id)?;
    let html = designs::read_system_page(&project, &file).map_err(failure)?;
    Ok(plain_text(html))
}

/// GET /design-files/system/{token}/{project}/system/{*path}
///
/// Read-only files of the Project's design system. The path ends in
/// `system/…` so a page's relative URLs read the same as inside a task.
pub async fn serve_design_system_file(
    State(auth): State<Arc<ServerAuth>>,
    Path((token, project, path)): Path<(String, String, String)>,
) -> Result<Response, Failure> {
    if !auth.verify_plugin_asset_token(&system_scope(&project), &token) {
        return Err((
            StatusCode::UNAUTHORIZED,
            "design session required".to_string(),
        ));
    }
    let file = designs::resolve_system_file(&project, &path).map_err(failure)?;
    file_response(&file)
}

/// One file under a task's `design/`, as a page's frame loads it.
pub(crate) fn design_file(project: &str, task_id: &str, path: &str) -> Result<Response, Failure> {
    let file = designs::resolve_file(project, task_id, path).map_err(failure)?;
    file_response(&file)
}

fn file_response(file: &std::path::Path) -> Result<Response, Failure> {
    let bytes =
        std::fs::read(file).map_err(|_| (StatusCode::NOT_FOUND, "file not found".to_string()))?;
    let content_type = mime_guess::from_path(file).first_or_octet_stream();
    let mut response = (
        [
            (header::CONTENT_TYPE, content_type.as_ref().to_string()),
            (header::CACHE_CONTROL, "no-store".to_string()),
            // The frame has an opaque origin, so its fonts, module scripts and
            // fetches are cross-origin. Holding the path is the permission.
            (header::ACCESS_CONTROL_ALLOW_ORIGIN, "*".to_string()),
            (header::REFERRER_POLICY, "no-referrer".to_string()),
            (header::X_CONTENT_TYPE_OPTIONS, "nosniff".to_string()),
        ],
        bytes,
    )
        .into_response();
    if crate::api::handlers::files::is_active_content(&content_type) {
        // Opened on its own, a page still gets no access to Grove.
        response.headers_mut().insert(
            header::CONTENT_SECURITY_POLICY,
            "sandbox allow-scripts; frame-ancestors 'self'"
                .parse()
                .expect("static CSP"),
        );
    }
    Ok(response)
}

// ─── Comments ────────────────────────────────────────────────────────────────

#[derive(Debug, Serialize)]
pub struct DesignReply {
    id: u32,
    author: String,
    content: String,
    timestamp: String,
}

#[derive(Debug, Serialize)]
pub struct DesignComment {
    id: u32,
    design: String,
    page: String,
    /// Where on the page: the element and its place when the comment was made.
    anchor: Value,
    author: String,
    content: String,
    timestamp: String,
    status: &'static str,
    via_share: bool,
    replies: Vec<DesignReply>,
}

impl DesignComment {
    pub fn is_open(&self) -> bool {
        self.status == "open"
    }

    pub fn design(&self) -> &str {
        &self.design
    }

    pub fn page(&self) -> &str {
        &self.page
    }

    /// The comment for an agent: id, who, which element, what was said.
    pub fn describe(&self) -> String {
        let mut out = format!("- #{} by {}", self.id, self.author);
        let text = |key: &str| {
            self.anchor
                .get(key)
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
        };
        match (text("selector"), text("text")) {
            (Some(selector), Some(visible)) => {
                out.push_str(&format!(" on `{selector}` (\"{visible}\")"))
            }
            (Some(selector), None) => out.push_str(&format!(" on `{selector}`")),
            _ => out.push_str(" on the page"),
        }
        out.push_str(&format!(": {}\n", self.content));
        for reply in &self.replies {
            out.push_str(&format!("  - {}: {}\n", reply.author, reply.content));
        }
        out
    }
}

/// `design/<design>/<page>` → (design, page).
pub fn split_design_path(path: &str) -> Option<(&str, &str)> {
    let (slug, file) = path.strip_prefix("design/")?.split_once('/')?;
    (designs::valid_name(slug) && designs::valid_name(file)).then_some((slug, file))
}

/// Comments left on design pages. They are review comments on the page file,
/// with the element kept in `anchor_text`.
pub fn design_comments(project: &str, task_id: &str) -> Result<Vec<DesignComment>, GroveError> {
    let shared = comments::share_comment_visitors(project, task_id).unwrap_or_default();
    Ok(comments::load_comments(project, task_id)?
        .comments
        .into_iter()
        .filter_map(|comment| {
            let (slug, file) = split_design_path(comment.file_path.as_deref()?)?;
            Some(DesignComment {
                id: comment.id,
                design: slug.to_string(),
                page: file.to_string(),
                anchor: comment
                    .anchor_text
                    .as_deref()
                    .and_then(|text| serde_json::from_str(text).ok())
                    .unwrap_or(Value::Null),
                author: comments::build_author(&comment.agent, &comment.role),
                content: comment.content,
                timestamp: comment.timestamp,
                status: match comment.status {
                    comments::CommentStatus::Resolved => "resolved",
                    _ => "open",
                },
                via_share: shared.contains_key(&comment.id),
                replies: comment
                    .replies
                    .into_iter()
                    .map(|reply| DesignReply {
                        id: reply.id,
                        author: comments::build_author(&reply.agent, &reply.role),
                        content: reply.content,
                        timestamp: reply.timestamp,
                    })
                    .collect(),
            })
        })
        .collect())
}

fn comments_json(project: &str, task_id: &str) -> Result<Json<Value>, Failure> {
    let list = design_comments(project, task_id).map_err(failure)?;
    Ok(Json(json!({
        "comments": list,
        "me": get_git_user_name(project, task_id),
    })))
}

/// GET /projects/{id}/tasks/{taskId}/designs/comments
pub async fn list_design_comments(
    Path((id, task_id)): Path<(String, String)>,
) -> Result<Json<Value>, Failure> {
    let project = studio_project(&id)?;
    comments_json(&project, &task_id)
}

#[derive(Debug, Deserialize)]
pub struct NewDesignComment {
    design: String,
    page: String,
    #[serde(default)]
    anchor: Value,
    content: String,
}

const COMMENT_LIMIT: usize = 10_000;
const ANCHOR_LIMIT: usize = 8_000;

/// Where a comment sits on its page, as stored. An anchor too large to be
/// one is left out, and the comment is then on the page as a whole.
pub fn anchor_text(anchor: &Value) -> Option<String> {
    anchor
        .is_object()
        .then(|| anchor.to_string())
        .filter(|text| text.len() <= ANCHOR_LIMIT)
}

/// POST /projects/{id}/tasks/{taskId}/designs/comments
pub async fn create_design_comment(
    Path((id, task_id)): Path<(String, String)>,
    Json(request): Json<NewDesignComment>,
) -> Result<Json<Value>, Failure> {
    let project = studio_project(&id)?;
    let content = request.content.trim();
    if content.is_empty() || content.chars().count() > COMMENT_LIMIT {
        return Err((
            StatusCode::BAD_REQUEST,
            format!("A comment needs 1 to {COMMENT_LIMIT} characters"),
        ));
    }
    // The page has to exist.
    designs::read_page(&project, &task_id, &request.design, &request.page).map_err(failure)?;
    let anchor = anchor_text(&request.anchor);
    let author = get_git_user_name(&project, &task_id).unwrap_or_else(|| "You".to_string());
    let (agent, role) = comments::parse_author_to_agent_role(&author);
    comments::add_comment(
        &project,
        &task_id,
        comments::CommentType::File,
        Some(format!("design/{}/{}", request.design, request.page)),
        None,
        None,
        None,
        content,
        &agent,
        "",
        &role,
        anchor,
    )
    .map_err(failure)?;
    comments_json(&project, &task_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn design_paths() {
        assert_eq!(
            split_design_path("design/insight/overview.html"),
            Some(("insight", "overview.html"))
        );
        assert_eq!(
            split_design_path("design/system/tokens.html"),
            Some(("system", "tokens.html"))
        );
        assert_eq!(split_design_path("output/report.md"), None);
        assert_eq!(split_design_path("design/insight/pages/a.html"), None);
        assert_eq!(split_design_path("design/../a.html"), None);
    }
}

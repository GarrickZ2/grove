//! Task sharing over HTTP (see `storage::shares`).
//!
//! Three groups of routes:
//! - The owner's own: create, list and stop links (behind the usual auth).
//! - `/share/{token}/…`: what a link opens. Outside the auth layer; the token
//!   picks the Task, a visitor key (Bearer or cookie) says who is looking.
//! - `/shared/…`: links this Grove opened. The server talks to the owner's
//!   Grove, so every window of this Grove sees the same list.

use std::collections::HashMap;
use std::time::Duration;

use axum::body::{Body, Bytes};
use axum::extract::{Path, Query, RawQuery};
use axum::http::{header, HeaderMap, HeaderValue, Method, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::error::GroveError;
use crate::storage::shares::{self, Received, Share, ShareScope, ShareState, Visitor, VisitorKind};
use crate::storage::{comments, config, tasks, workspace};

type ShareError = (StatusCode, Json<Value>);

fn fail(status: StatusCode, code: &str, message: impl Into<String>) -> ShareError {
    (
        status,
        Json(json!({ "error": message.into(), "code": code })),
    )
}

/// Why a link no longer opens for someone, signed with the owner's name so
/// the page can say who to ask.
fn ended(status: StatusCode, code: &str, message: &str) -> ShareError {
    (
        status,
        Json(json!({ "error": message, "code": code, "owner": my_name() })),
    )
}

fn grove_error(error: GroveError) -> ShareError {
    match error {
        GroveError::InvalidData(message) => fail(StatusCode::BAD_REQUEST, "invalid", message),
        GroveError::NotFound(message) => fail(StatusCode::NOT_FOUND, "not_found", message),
        // The details stay in this Grove's log: share routes answer people
        // outside it, and SQL or paths mean nothing to them anyway.
        other => {
            eprintln!("[share] {other}");
            fail(
                StatusCode::INTERNAL_SERVER_ERROR,
                "internal",
                "Something went wrong on this Grove. Try again later.",
            )
        }
    }
}

/// An error from Grove's own handlers, put for someone outside this Grove:
/// a fixed message, with the original kept in the log.
fn outside(status: StatusCode, code: &str, detail: &str, shown: &str) -> ShareError {
    eprintln!("[share] {code}: {detail}");
    fail(status, code, shown)
}

fn state_error(state: ShareState) -> ShareError {
    match state {
        ShareState::Expired => ended(StatusCode::GONE, "expired", "This link has expired"),
        ShareState::Exhausted => ended(
            StatusCode::GONE,
            "exhausted",
            "This link was for someone else",
        ),
        ShareState::Revoked => ended(StatusCode::GONE, "revoked", "The owner stopped sharing"),
        ShareState::Active => fail(StatusCode::OK, "active", ""),
    }
}

// ============================================================================
// Names and the address other people use
// ============================================================================

fn home_dir() -> String {
    dirs::home_dir()
        .map(|path| path.to_string_lossy().to_string())
        .unwrap_or_else(|| ".".into())
}

/// A value worked out now and then, not on every request.
struct Remembered<T> {
    value: std::sync::Mutex<Option<(T, std::time::Instant)>>,
}

impl<T: Clone> Remembered<T> {
    const fn new() -> Self {
        Self {
            value: std::sync::Mutex::new(None),
        }
    }

    fn get(&self, max_age: Duration, matches: impl Fn(&T) -> bool) -> Option<T> {
        let guard = self.value.lock().ok()?;
        guard
            .as_ref()
            .filter(|(value, at)| at.elapsed() < max_age && matches(value))
            .map(|(value, _)| value.clone())
    }

    fn set(&self, value: T) {
        if let Ok(mut guard) = self.value.lock() {
            *guard = Some((value, std::time::Instant::now()));
        }
    }
}

static SUGGESTED_NAME: Remembered<String> = Remembered::new();

/// The name to offer the first time: git's user.name, else the machine's.
fn suggested_name() -> String {
    if let Some(name) = SUGGESTED_NAME.get(Duration::from_secs(300), |_| true) {
        return name;
    }
    let name = read_suggested_name();
    SUGGESTED_NAME.set(name.clone());
    name
}

fn read_suggested_name() -> String {
    crate::git::git_user_name(&home_dir())
        .map(|name| name.trim().to_string())
        .filter(|name| !name.is_empty())
        .or_else(|| crate::machines::this().ok().map(|profile| profile.name))
        .unwrap_or_else(|| "Grove".into())
}

fn chosen_name() -> Option<String> {
    config::load_config()
        .share
        .name
        .filter(|name| !name.trim().is_empty())
}

/// The name this Grove goes by when it shares or comments.
pub fn my_name() -> String {
    chosen_name().unwrap_or_else(suggested_name)
}

fn machine_name() -> String {
    crate::machines::this()
        .map(|profile| profile.name)
        .unwrap_or_default()
}

/// What this Grove goes by on one link: steady, so a removal sticks and a
/// second open stays one visitor, whatever address the link came by; and
/// different for each link, so owners can't match it up.
fn client_for(token: &str) -> String {
    use sha2::{Digest, Sha256};
    let id = crate::machines::this()
        .map(|profile| profile.id)
        .unwrap_or_default();
    if id.is_empty() {
        return String::new();
    }
    hex::encode(Sha256::digest(
        format!("grove-share:{id}:{token}").as_bytes(),
    ))
}

fn share_client() -> reqwest::Client {
    reqwest::Client::builder()
        // `grove remote` serves a self-signed certificate on the LAN.
        .danger_accept_invalid_certs(true)
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(15))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new())
}

/// For carrying a whole response through, however big: no overall limit,
/// only one on connecting and on a stalled transfer.
fn share_stream_client() -> reqwest::Client {
    reqwest::Client::builder()
        .danger_accept_invalid_certs(true)
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(10))
        .read_timeout(Duration::from_secs(30))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new())
}

fn normalize_address(value: &str) -> Option<String> {
    let value = value.trim().trim_end_matches('/');
    if value.is_empty() {
        return None;
    }
    let with_scheme = if value.contains("://") {
        value.to_string()
    } else {
        format!("https://{value}")
    };
    let url = url::Url::parse(&with_scheme).ok()?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        return None;
    }
    Some(format!("{}://{}", url.scheme(), url.authority()))
}

/// The address links carry: the one this window was told to use (kept by
/// the window itself), else the window's own address. Whether others can
/// reach it is up to whoever holds the link.
fn resolve_address(headers: &HeaderMap, chosen: Option<&str>) -> (String, &'static str) {
    if let Some(address) = chosen.and_then(normalize_address) {
        return (address, "custom");
    }
    let host = headers
        .get(header::HOST)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("localhost:3001");
    let scheme = headers
        .get("x-forwarded-proto")
        .and_then(|v| v.to_str().ok())
        .map(str::to_string)
        .unwrap_or_else(|| std::env::var("GROVE_PROTOCOL").unwrap_or_else(|_| "http".into()));
    (format!("{scheme}://{host}"), "window")
}

#[derive(Deserialize)]
pub struct ProfileInput {
    #[serde(default)]
    name: Option<String>,
}

/// GET /api/v1/share-profile
pub async fn get_profile() -> Json<Value> {
    Json(json!({
        "name": chosen_name(),
        "suggestedName": suggested_name(),
        "device": machine_name(),
    }))
}

/// PUT /api/v1/share-profile
pub async fn put_profile(Json(input): Json<ProfileInput>) -> Result<Json<Value>, ShareError> {
    let mut config = config::load_config();
    if let Some(name) = input.name {
        config.share.name = Some(shares::clean_name(&name).map_err(grove_error)?);
    }
    config::save_config(&config).map_err(grove_error)?;
    Ok(get_profile().await)
}

// ============================================================================
// The owner's links
// ============================================================================

fn link_json(share: &Share, address: &str, comments: u32) -> Value {
    let everyone = shares::list_visitors(&share.token).unwrap_or_default();
    let visitors: Vec<Value> = everyone
        .iter()
        .filter(|visitor| visitor.removed_at.is_none())
        .map(|visitor| {
            json!({
                "id": visitor.id,
                "name": visitor.name,
                "kind": visitor.kind,
                "device": visitor.device,
                "lastOpenAt": visitor.last_open_at,
                "rejoined": shares::rejoined(visitor, &everyone),
            })
        })
        .collect();
    json!({
        "token": share.token,
        "url": format!("{address}/s/{}", share.token),
        "canComment": share.can_comment,
        "scope": share.scope,
        "expiresAt": share.expires_at,
        "maxPeople": share.max_opens,
        "people": share.opens,
        "state": share.state(),
        "createdAt": share.created_at,
        "visitors": visitors,
        "comments": comments,
    })
}

fn task_key(project_id: &str) -> Result<String, ShareError> {
    super::common::find_project_by_id(project_id)
        .map(|(_, key)| key)
        .map_err(|_| fail(StatusCode::NOT_FOUND, "not_found", "Project not found"))
}

#[derive(Deserialize)]
pub struct AddressQuery {
    /// The address this window was told links should use.
    #[serde(default)]
    address: Option<String>,
}

/// GET /api/v1/projects/{id}/tasks/{taskId}/shares
pub async fn list_links(
    Path((id, task_id)): Path<(String, String)>,
    Query(query): Query<AddressQuery>,
    headers: HeaderMap,
) -> Result<Json<Value>, ShareError> {
    let key = task_key(&id)?;
    let (address, source) = resolve_address(&headers, query.address.as_deref());
    let all_counts = shares::comment_counts(&key, &task_id).map_err(grove_error)?;
    let open_comments: u32 = all_counts.iter().map(|(_, _, open)| open).sum();
    let counts: HashMap<String, u32> = all_counts
        .into_iter()
        .map(|(token, total, _)| (token, total))
        .collect();
    let links: Vec<Value> = shares::list_shares(&key, &task_id)
        .map_err(grove_error)?
        .iter()
        // Links that stopped working long ago only clutter the list.
        .filter(|share| share.state() == ShareState::Active || recently_ended(share))
        .map(|share| {
            link_json(
                share,
                &address,
                counts.get(&share.token).copied().unwrap_or(0),
            )
        })
        .collect();
    Ok(Json(json!({
        "address": address,
        "addressSource": source,
        "links": links,
        "openComments": open_comments,
    })))
}

/// Links that ended within the last week stay visible, so the owner can see
/// what happened to them.
fn recently_ended(share: &Share) -> bool {
    let ended = match share.state() {
        ShareState::Active => return true,
        ShareState::Revoked => share.revoked_at.clone(),
        ShareState::Expired => share.expires_at.clone(),
        // Full, but the people on it still use it.
        ShareState::Exhausted => return true,
    };
    ended
        .as_deref()
        .and_then(|time| chrono::DateTime::parse_from_rfc3339(time).ok())
        .is_some_and(|time| {
            chrono::Utc::now().signed_duration_since(time) < chrono::Duration::days(7)
        })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateLinkInput {
    #[serde(default)]
    can_comment: bool,
    #[serde(default)]
    expires_in_days: Option<u32>,
    /// How many people may open it; none for anyone with the link.
    #[serde(default)]
    max_people: Option<u32>,
    /// The address this window was told links should use.
    #[serde(default)]
    address: Option<String>,
    /// What the link shows; none for the whole Task.
    #[serde(default)]
    scope: Option<ShareScope>,
}

/// POST /api/v1/projects/{id}/tasks/{taskId}/shares
pub async fn create_link(
    Path((id, task_id)): Path<(String, String)>,
    headers: HeaderMap,
    Json(input): Json<CreateLinkInput>,
) -> Result<Json<Value>, ShareError> {
    let key = task_key(&id)?;
    if tasks::get_task(&key, &task_id)
        .map_err(grove_error)?
        .is_none()
    {
        return Err(fail(StatusCode::NOT_FOUND, "not_found", "Task not found"));
    }
    let (address, _) = resolve_address(&headers, input.address.as_deref());
    let share = shares::create_share(
        &key,
        &task_id,
        input.can_comment,
        input.expires_in_days,
        input.max_people,
        input.scope,
    )
    .map_err(grove_error)?;
    Ok(Json(link_json(&share, &address, 0)))
}

#[derive(Deserialize)]
pub struct ScopeInput {
    #[serde(default)]
    scope: Option<ShareScope>,
}

/// PUT /api/v1/shares/{token}/scope — change what a link shows.
pub async fn set_link_scope(
    Path(token): Path<String>,
    Json(input): Json<ScopeInput>,
) -> Result<StatusCode, ShareError> {
    if !shares::set_scope(&token, input.scope).map_err(grove_error)? {
        return Err(fail(StatusCode::NOT_FOUND, "not_found", "Link not found"));
    }
    Ok(StatusCode::NO_CONTENT)
}

/// GET /api/v1/projects/{id}/tasks/{taskId}/share-items — what a link of
/// this Task can show, to choose from.
pub async fn share_items(
    Path((id, task_id)): Path<(String, String)>,
) -> Result<Json<Value>, ShareError> {
    let key = task_key(&id)?;
    let project = workspace::load_project_by_hash(&key)
        .ok()
        .flatten()
        .ok_or_else(|| fail(StatusCode::NOT_FOUND, "not_found", "Project not found"))?;
    let studio = project.project_type == workspace::ProjectType::Studio;
    let mut reviews = Vec::new();
    if !studio {
        reviews.push(json!({ "id": "", "name": project.name }));
    }
    for (id, name) in linked_projects_reviews(&key, &task_id) {
        reviews.push(json!({ "id": id, "name": name }));
    }
    let (designs, sketches, files) = if studio {
        let designs: Vec<Value> = crate::storage::designs::list_designs(&key, &task_id)
            .unwrap_or_default()
            .into_iter()
            .filter(|design| !design.is_system)
            .map(|design| json!({ "id": design.slug, "name": design.name }))
            .collect();
        let sketches: Vec<Value> = crate::storage::sketches::load_index(&key, &task_id)
            .map(|index| index.sketches)
            .unwrap_or_default()
            .into_iter()
            .map(|sketch| json!({ "id": sketch.id, "name": sketch.name }))
            .collect();
        let files: Vec<String> = super::tasks::list_artifacts(Path((key.clone(), task_id)))
            .await
            .map(|Json(artifacts)| artifacts.output)
            .unwrap_or_default()
            .into_iter()
            .filter(|file| !file.is_dir)
            .map(|file| file.path)
            .collect();
        (designs, sketches, files)
    } else {
        (Vec::new(), Vec::new(), Vec::new())
    };
    Ok(Json(json!({
        "reviews": reviews,
        "designs": designs,
        "sketches": sketches,
        "files": files,
    })))
}

/// POST /api/v1/shares/{token}/stop
pub async fn revoke_link(Path(token): Path<String>) -> Result<StatusCode, ShareError> {
    shares::revoke_share(&token).map_err(grove_error)?;
    Ok(StatusCode::NO_CONTENT)
}

/// DELETE /api/v1/shares/{token} — forget the link entirely.
pub async fn delete_link(Path(token): Path<String>) -> Result<StatusCode, ShareError> {
    shares::delete_share(&token).map_err(grove_error)?;
    Ok(StatusCode::NO_CONTENT)
}

/// DELETE /api/v1/shares/{token}/visitors/{visitorId}
pub async fn remove_visitor(
    Path((token, visitor_id)): Path<(String, String)>,
) -> Result<StatusCode, ShareError> {
    shares::remove_visitor(&token, &visitor_id).map_err(grove_error)?;
    Ok(StatusCode::NO_CONTENT)
}

// ============================================================================
// What a link opens
// ============================================================================

fn cookie_name(token: &str) -> String {
    format!("grove_share_{token}")
}

fn credential(headers: &HeaderMap, token: &str) -> Option<String> {
    if let Some(bearer) = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
    {
        return Some(bearer.trim().to_string());
    }
    let name = cookie_name(token);
    headers
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| value.split(';'))
        .filter_map(|pair| pair.trim().split_once('='))
        .find(|(key, _)| *key == name)
        .map(|(_, value)| value.to_string())
}

fn load_share(token: &str) -> Result<Share, ShareError> {
    shares::get_share(token)
        .map_err(grove_error)?
        .ok_or_else(|| {
            fail(
                StatusCode::NOT_FOUND,
                "not_found",
                "This link doesn't exist",
            )
        })
}

/// Whether the credential belongs to someone the owner removed from the link.
fn was_removed(headers: &HeaderMap, token: &str) -> bool {
    credential(headers, token)
        .and_then(|credential| credential.split_once('.').map(|(id, _)| id.to_string()))
        .and_then(|id| shares::get_visitor(&id).ok().flatten())
        .is_some_and(|visitor| visitor.token == token && visitor.removed_at.is_some())
}

/// The link and the person, when both are still good.
fn visitor_for(headers: &HeaderMap, token: &str) -> Result<(Share, Visitor), ShareError> {
    let share = load_share(token)?;
    let Some(visitor) = credential(headers, token)
        .map(|credential| shares::authenticate(token, &credential))
        .transpose()
        .map_err(grove_error)?
        .flatten()
    else {
        // A removed visitor reads as "removed", anyone else must join first.
        return Err(if was_removed(headers, token) {
            ended(
                StatusCode::FORBIDDEN,
                "removed",
                "The owner removed you from this link",
            )
        } else {
            fail(StatusCode::UNAUTHORIZED, "join", "Enter your name first")
        });
    };
    if !task_exists(&share) {
        return Err(task_gone());
    }
    match share.state() {
        ShareState::Active => Ok((share, visitor)),
        ShareState::Exhausted if shares::has_opened(&visitor) => Ok((share, visitor)),
        state => Err(state_error(state)),
    }
}

/// What the link is, for anyone holding it.
fn share_info(share: &Share, visitor: Option<&Visitor>) -> Value {
    let task = tasks::get_task(&share.project_key, &share.task_id)
        .ok()
        .flatten();
    let project = workspace::load_project_by_hash(&share.project_key)
        .ok()
        .flatten();
    let share_comments =
        comments::share_comment_visitors(&share.project_key, &share.task_id).unwrap_or_default();
    // Activity a collaborator cares about: the Task moved, or someone
    // answered a comment written through a link.
    let mut activity = task.as_ref().map(|task| task.updated_at.to_rfc3339());
    if let Ok(data) = comments::load_comments(&share.project_key, &share.task_id) {
        for comment in data
            .comments
            .iter()
            .filter(|c| share_comments.contains_key(&c.id))
        {
            for reply in &comment.replies {
                if activity.as_deref() < Some(reply.timestamp.as_str()) {
                    activity = Some(reply.timestamp.clone());
                }
            }
        }
    }
    json!({
        "owner": my_name(),
        "ownerDevice": machine_name(),
        // The local task is named after its project; its branch says more.
        "title": task
            .as_ref()
            .map(|task| if task.is_local { task.branch.clone() } else { task.name.clone() })
            .unwrap_or_default(),
        "project": project.map(|project| project.name).unwrap_or_default(),
        "canComment": share.can_comment,
        "expiresAt": share.expires_at,
        "maxPeople": share.max_opens,
        "people": share.opens,
        "state": if task.is_none() {
            "missing".into()
        } else {
            match share.state() {
                // Full for new people; whoever is on it keeps it.
                ShareState::Exhausted if visitor.is_some_and(shares::has_opened) => json!("active"),
                state => json!(state),
            }
        },
        "activityAt": activity,
        // Whether the Task has a Code Review of its own (Studio Tasks don't),
        // and those of the Projects it links, which the link also shows.
        "ownReview": shows_own_review(share),
        "reviews": linked_reviews(share)
            .into_iter()
            .map(|(id, name)| json!({ "id": id, "name": name }))
            .collect::<Vec<_>>(),
        "you": visitor.map(|visitor| json!({
            "id": visitor.id,
            "name": visitor.name,
            "kind": visitor.kind,
        })),
    })
}

/// GET /api/v1/share/{token}
///
/// While the link works for the caller: what it is. Once it doesn't (stopped,
/// expired, used up, the caller removed, the Task gone): only why, and whose.
pub async fn public_info(
    Path(token): Path<String>,
    headers: HeaderMap,
) -> Result<Json<Value>, ShareError> {
    let share = load_share(&token)?;
    let visitor = credential(&headers, &token)
        .and_then(|credential| shares::authenticate(&token, &credential).ok().flatten());
    let state = if visitor.is_none() && was_removed(&headers, &token) {
        json!("removed")
    } else if !task_exists(&share) {
        json!("missing")
    } else {
        match share.state() {
            ShareState::Active => json!("active"),
            // Full for new people; those already on it keep it.
            ShareState::Exhausted if visitor.as_ref().is_some_and(shares::has_opened) => {
                json!("active")
            }
            state => json!(state),
        }
    };
    if state != "active" {
        return Ok(Json(json!({ "owner": my_name(), "state": state })));
    }
    let mut info = share_info(&share, visitor.as_ref());
    info["state"] = state;
    Ok(Json(info))
}

fn task_exists(share: &Share) -> bool {
    tasks::get_task(&share.project_key, &share.task_id)
        .ok()
        .flatten()
        .is_some()
}

fn task_gone() -> ShareError {
    ended(StatusCode::GONE, "missing", "This task is gone")
}

#[derive(Deserialize)]
pub struct JoinInput {
    name: String,
    #[serde(default)]
    kind: Option<String>,
    #[serde(default)]
    device: Option<String>,
    /// Stands for the joining Grove on this link only.
    #[serde(default)]
    client: Option<String>,
}

/// Each link takes this many people at most.
const VISITOR_LIMIT: usize = 200;

/// POST /api/v1/share/{token}/join — give a name, get a key, count an open.
pub async fn public_join(
    Path(token): Path<String>,
    headers: HeaderMap,
    Json(input): Json<JoinInput>,
) -> Result<Response, ShareError> {
    let share = load_share(&token)?;
    let state = share.state();
    if state != ShareState::Active {
        return Err(state_error(state));
    }
    if !task_exists(&share) {
        return Err(task_gone());
    }
    if shares::list_visitors(&token).map_err(grove_error)?.len() >= VISITOR_LIMIT {
        return Err(fail(
            StatusCode::TOO_MANY_REQUESTS,
            "full",
            "Too many people have opened this link",
        ));
    }
    let client = input.client.as_deref().unwrap_or("").trim();
    if was_removed(&headers, &token)
        || shares::client_removed(&token, client).map_err(grove_error)?
    {
        return Err(ended(
            StatusCode::FORBIDDEN,
            "removed",
            "The owner removed you from this link",
        ));
    }
    let kind = match input.kind.as_deref() {
        Some("grove") => VisitorKind::Grove,
        _ => VisitorKind::Browser,
    };
    let device = input.device.as_deref().unwrap_or("");
    let again = if kind == VisitorKind::Grove {
        shares::rejoin_visitor(&token, client, &input.name, device).map_err(grove_error)?
    } else {
        None
    };
    let rejoined = again.is_some();
    let (visitor, credential) = match again {
        Some(found) => found,
        None => {
            shares::add_visitor(&token, kind, &input.name, device, client).map_err(grove_error)?
        }
    };
    let state = shares::record_open(&share, &visitor).map_err(grove_error)?;
    if state != ShareState::Active {
        // Lost the race for the last open: as if they never joined.
        if !rejoined {
            let _ = shares::delete_visitor(&visitor.id);
        }
        return Err(state_error(state));
    }
    let share = load_share(&token)?;
    let visitor = shares::get_visitor(&visitor.id)
        .map_err(grove_error)?
        .unwrap_or(visitor);
    let mut body = share_info(&share, Some(&visitor));
    if kind == VisitorKind::Grove {
        body["credential"] = json!(credential);
    }
    let mut response = Json(body).into_response();
    if kind == VisitorKind::Browser {
        let secure = headers
            .get("x-forwarded-proto")
            .and_then(|v| v.to_str().ok())
            .map(|proto| proto == "https")
            .unwrap_or_else(|| std::env::var("GROVE_PROTOCOL").as_deref() == Ok("https"));
        let cookie = format!(
            "{}={credential}; Path=/api/v1/share/{token}; HttpOnly; SameSite=Lax; Max-Age=31536000{}",
            cookie_name(&token),
            if secure { "; Secure" } else { "" }
        );
        if let Ok(value) = HeaderValue::from_str(&cookie) {
            response.headers_mut().insert(header::SET_COOKIE, value);
        }
    }
    Ok(response)
}

/// POST /api/v1/share/{token}/open — count this visit.
pub async fn public_open(
    Path(token): Path<String>,
    headers: HeaderMap,
) -> Result<Json<Value>, ShareError> {
    let share = load_share(&token)?;
    let Some(visitor) = credential(&headers, &token)
        .and_then(|credential| shares::authenticate(&token, &credential).ok().flatten())
    else {
        return Err(visitor_for(&headers, &token)
            .err()
            .unwrap_or_else(|| fail(StatusCode::UNAUTHORIZED, "join", "Enter your name first")));
    };
    if !task_exists(&share) {
        return Err(task_gone());
    }
    let state = shares::record_open(&share, &visitor).map_err(grove_error)?;
    if state != ShareState::Active {
        return Err(state_error(state));
    }
    let share = load_share(&token)?;
    let visitor = shares::get_visitor(&visitor.id)
        .map_err(grove_error)?
        .unwrap_or(visitor);
    Ok(Json(share_info(&share, Some(&visitor))))
}

/// GET /api/v1/share/{token}/diff
pub async fn public_diff(
    Path(token): Path<String>,
    headers: HeaderMap,
    Query(review): Query<ReviewQuery>,
) -> Result<Response, ShareError> {
    let (share, _) = visitor_for(&headers, &token)?;
    if review.project.is_none() && !shows_own_review(&share) {
        return Ok(
            Json(json!({ "files": [], "total_additions": 0, "total_deletions": 0 }))
                .into_response(),
        );
    }
    let target = review_target(&share, review.project.as_deref())?;
    match super::tasks::get_diff(
        Path(target),
        Query(super::tasks::DiffQuery {
            from_ref: None,
            to_ref: None,
        }),
    )
    .await
    {
        Ok(json) => Ok(json.into_response()),
        Err((status, Json(error))) => Err(outside(
            status,
            "diff",
            &error.error,
            "Couldn't load the changes",
        )),
    }
}

#[derive(Deserialize)]
pub struct FileDiffQuery {
    path: String,
    #[serde(default)]
    old_path: Option<String>,
    #[serde(default)]
    project: Option<String>,
}

/// GET /api/v1/share/{token}/diff/file?path=…
pub async fn public_file_diff(
    Path(token): Path<String>,
    headers: HeaderMap,
    Query(query): Query<FileDiffQuery>,
) -> Result<Response, ShareError> {
    let (share, _) = visitor_for(&headers, &token)?;
    if !plain_relative(&query.path)
        || query
            .old_path
            .as_deref()
            .is_some_and(|p| !plain_relative(p))
    {
        return Err(fail(StatusCode::NOT_FOUND, "not_found", "File not found"));
    }
    let target = review_target(&share, query.project.as_deref())?;
    if query.project.is_none() && !shows_own_review(&share) {
        return Err(fail(StatusCode::NOT_FOUND, "not_found", "File not found"));
    }
    super::tasks::get_single_file_diff(
        Path(target),
        Query(super::tasks::SingleFileDiffQuery {
            path: query.path,
            old_path: query.old_path,
            from_ref: None,
            to_ref: None,
        }),
    )
    .await
    .map_err(|status| fail(status, "diff", "Couldn't load this file's changes"))
}

/// GET /api/v1/share/{token}/diff/content?path=… — a changed file as the
/// Task has it now, so the review can show the lines around a change.
pub async fn public_file_content(
    Path(token): Path<String>,
    headers: HeaderMap,
    Query(query): Query<SharedFileQuery>,
) -> Result<Json<Value>, ShareError> {
    use crate::platform::CanonicalPath;
    let (share, _) = visitor_for(&headers, &token)?;
    let not_found = || fail(StatusCode::NOT_FOUND, "not_found", "File not found");
    let (project, task_id) = review_target(&share, query.project.as_deref())?;
    if (query.project.is_none() && !shows_own_review(&share))
        || !changed_path(&project, &task_id, &query.path).await
    {
        return Err(not_found());
    }
    let task = tasks::get_task(&project, &task_id)
        .ok()
        .flatten()
        .ok_or_else(task_gone)?;
    let root = std::path::Path::new(&task.worktree_path)
        .canonical()
        .map_err(|_| not_found())?;
    // A changed file may be a link to somewhere else; only read what is
    // really inside the Task.
    let file = root
        .join(&query.path)
        .canonical()
        .map_err(|_| not_found())?;
    if !file.starts_with(&root) || !file.is_file() {
        return Err(not_found());
    }
    let content = std::fs::read_to_string(&file).map_err(|_| not_found())?;
    Ok(Json(json!({ "content": content, "path": query.path })))
}

#[derive(Deserialize, Default)]
pub struct ReviewQuery {
    /// A linked Project whose Code Review to read instead of the Task's own.
    #[serde(default)]
    project: Option<String>,
}

/// The Code Reviews of the Projects a Task links, as its owner's Review
/// panel shows them: (project id, name), in link order. Each is that
/// Project's Local Task.
fn linked_reviews(share: &Share) -> Vec<(String, String)> {
    let scope = scope_of(share);
    linked_projects_reviews(&share.project_key, &share.task_id)
        .into_iter()
        .filter(|(id, _)| scope.allows_review(id))
        .collect()
}

/// Every linked Project with a Code Review, whatever a link shows.
fn linked_projects_reviews(project_key: &str, task_id: &str) -> Vec<(String, String)> {
    let ids = tasks::load_linked_project_ids(project_key, task_id).unwrap_or_default();
    if ids.is_empty() {
        return Vec::new();
    }
    let registered = workspace::load_projects().unwrap_or_default();
    super::tasks::linked_projects::resolve_items(ids, &registered)
        .linked_projects
        .into_iter()
        .filter(|item| item.exists && item.review_task_id.is_some())
        .map(|item| (item.id, item.name))
        .collect()
}

fn scope_of(share: &Share) -> ShareScope {
    share.scope.clone().unwrap_or_default()
}

/// Whether the link shows the Task's own Code Review.
fn shows_own_review(share: &Share) -> bool {
    studio_or_repo(share) == ProjectKind::Repo && scope_of(share).allows_review("")
}

/// Whether someone on the link sees a comment on the shared Task: one on
/// something the link shows. Comments on the Task itself need the whole Task.
fn comment_in_scope(share: &Share, comment: &comments::Comment) -> bool {
    let Some(scope) = share.scope.as_ref() else {
        return true;
    };
    let Some(path) = comment.file_path.as_deref() else {
        return false;
    };
    if matches!(comment.comment_type, comments::CommentType::Project) {
        return false;
    }
    if let Some((design, _)) = super::tasks::designs::split_design_path(path) {
        return scope.allows_design(design);
    }
    if let Some(sketch) = super::tasks::split_sketch_path(path) {
        return scope.allows_sketch(sketch);
    }
    if let Some(file) = path.strip_prefix("output/") {
        return scope.allows_file(file);
    }
    studio_or_repo(share) == ProjectKind::Repo && scope.allows_review("")
}

/// Whose review a request reads: the shared Task's own, or a linked
/// Project's Local Task when `project` names one the link shows.
fn review_target(share: &Share, project: Option<&str>) -> Result<(String, String), ShareError> {
    match project.filter(|id| !id.is_empty()) {
        None => Ok((share.project_key.clone(), share.task_id.clone())),
        Some(id) if linked_reviews(share).iter().any(|(linked, _)| linked == id) => {
            Ok((id.to_string(), tasks::LOCAL_TASK_ID.to_string()))
        }
        Some(_) => Err(fail(StatusCode::NOT_FOUND, "not_found", "Not found")),
    }
}

#[derive(PartialEq)]
enum ProjectKind {
    Studio,
    Repo,
}

fn studio_or_repo(share: &Share) -> ProjectKind {
    match workspace::load_project_by_hash(&share.project_key)
        .ok()
        .flatten()
    {
        Some(project) if project.project_type == workspace::ProjectType::Studio => {
            ProjectKind::Studio
        }
        _ => ProjectKind::Repo,
    }
}

/// GET /api/v1/share/{token}/files — the Task's output files.
pub async fn public_files(
    Path(token): Path<String>,
    headers: HeaderMap,
) -> Result<Json<Value>, ShareError> {
    let (share, _) = visitor_for(&headers, &token)?;
    if studio_or_repo(&share) == ProjectKind::Repo {
        return Ok(Json(json!({ "files": [] })));
    }
    let scope = scope_of(&share);
    let output = super::tasks::list_artifacts(Path((share.project_key, share.task_id)))
        .await
        .map(|Json(artifacts)| artifacts.output)
        .unwrap_or_default();
    // Chosen files only; a folder shows when a chosen file is inside it.
    let chosen: Vec<&str> = output
        .iter()
        .filter(|file| !file.is_dir && scope.allows_file(&file.path))
        .map(|file| file.path.as_str())
        .collect();
    let files: Vec<&super::tasks::ArtifactFile> = output
        .iter()
        .filter(|file| {
            if file.is_dir {
                let prefix = format!("{}/", file.path);
                chosen.iter().any(|path| path.starts_with(&prefix))
            } else {
                chosen.contains(&file.path.as_str())
            }
        })
        .collect();
    Ok(Json(json!({ "files": files })))
}

/// What makes a visitor's path to a link's design files theirs alone.
fn design_files_scope(token: &str, visitor: &str) -> String {
    // NUL never appears in a plugin id, so this cannot collide with one.
    format!("design-share\0{token}\0{visitor}")
}

/// GET /api/v1/share/{token}/designs — the Task's design boards, the comments
/// visitors left on them, and where the pages' own files load from.
pub async fn public_designs(
    axum::extract::State(auth): axum::extract::State<std::sync::Arc<crate::api::auth::ServerAuth>>,
    Path(token): Path<String>,
    headers: HeaderMap,
) -> Result<Json<Value>, ShareError> {
    use super::tasks::designs as design_api;
    let (share, visitor) = visitor_for(&headers, &token)?;
    if studio_or_repo(&share) == ProjectKind::Repo {
        return Ok(Json(json!({
            "designs": [], "comments": [], "me": visitor.name, "filesPath": "", "filesUrl": "",
        })));
    }
    let (project, task_id) = (share.project_key.as_str(), share.task_id.as_str());
    // The pages run in sandboxed frames that carry no cookie, so the files
    // they load are reached by a path that is itself the permission. It is
    // this visitor's on this link, and stops working when either ends.
    let files = format!(
        "/api/v1/share/{token}/design-files/{}/{}/",
        visitor.id,
        auth.plugin_asset_token(&design_files_scope(&token, &visitor.id))
    );
    let scope = scope_of(&share);
    let designs: Vec<_> = crate::storage::designs::list_designs(project, task_id)
        .unwrap_or_default()
        .into_iter()
        .filter(|design| {
            if design.is_system {
                scope.all_designs()
            } else {
                scope.allows_design(&design.slug)
            }
        })
        .collect();
    let comments: Vec<_> = design_api::shared_design_comments(project, task_id)
        .into_iter()
        .filter(|comment| scope.allows_design(comment.design()))
        .collect();
    Ok(Json(json!({
        "designs": designs,
        "comments": comments,
        "me": visitor.name,
        "filesPath": files,
        "filesUrl": format!("{}{files}", resolve_address(&headers, None).0.trim_end_matches('/')),
    })))
}

/// GET /api/v1/share/{token}/sketches — the Task's sketches and the comments on them.
pub async fn public_sketches(
    Path(token): Path<String>,
    headers: HeaderMap,
) -> Result<Json<Value>, ShareError> {
    let (share, visitor) = visitor_for(&headers, &token)?;
    if studio_or_repo(&share) == ProjectKind::Repo {
        return Ok(Json(
            json!({ "sketches": [], "comments": [], "me": visitor.name }),
        ));
    }
    let (project, task_id) = (share.project_key.as_str(), share.task_id.as_str());
    let scope = scope_of(&share);
    let sketches: Vec<_> = crate::storage::sketches::load_index(project, task_id)
        .map(|index| index.sketches)
        .unwrap_or_default()
        .into_iter()
        .filter(|sketch| scope.allows_sketch(&sketch.id))
        .collect();
    let comments: Vec<_> = super::tasks::sketch_comments(project, task_id)
        .unwrap_or_default()
        .into_iter()
        .filter(|comment| scope.allows_sketch(comment.sketch()))
        .collect();
    Ok(Json(json!({
        "sketches": sketches,
        "comments": comments,
        "me": visitor.name,
    })))
}

/// `sketches/{sketch}/scene`, with a well-formed sketch id.
fn is_sketch_scene_path(rest: &str) -> bool {
    let parts: Vec<&str> = rest.split('/').collect();
    matches!(parts.as_slice(), ["sketches", sketch, "scene"]
        if crate::storage::sketches::is_valid_sketch_id(sketch))
}

/// GET /api/v1/share/{token}/sketches/{sketch}/scene — a sketch's Excalidraw scene.
pub async fn public_sketch_scene(
    Path((token, sketch)): Path<(String, String)>,
    headers: HeaderMap,
) -> Result<Response, ShareError> {
    let (share, _) = visitor_for(&headers, &token)?;
    let not_found = || fail(StatusCode::NOT_FOUND, "not_found", "Not found");
    if studio_or_repo(&share) == ProjectKind::Repo
        || !scope_of(&share).allows_sketch(&sketch)
        || !super::tasks::sketch_exists(&share.project_key, &share.task_id, &sketch)
    {
        return Err(not_found());
    }
    let scene = crate::storage::sketches::load_scene(&share.project_key, &share.task_id, &sketch)
        .map_err(|_| not_found())?;
    Ok(([(header::CONTENT_TYPE, "application/json")], scene).into_response())
}

/// GET /api/v1/share/{token}/design-files/{visitor}/{pass}/{*path} — a file a
/// shared design page loads. Checked against the link on every request, so
/// it ends with the link.
pub async fn public_design_file(
    axum::extract::State(auth): axum::extract::State<std::sync::Arc<crate::api::auth::ServerAuth>>,
    Path((token, visitor_id, pass, path)): Path<(String, String, String, String)>,
) -> Result<Response, ShareError> {
    let not_found = || fail(StatusCode::NOT_FOUND, "not_found", "File not found");
    if !auth.verify_plugin_asset_token(&design_files_scope(&token, &visitor_id), &pass) {
        return Err(not_found());
    }
    let share = load_share(&token)?;
    let visitor = shares::get_visitor(&visitor_id)
        .map_err(grove_error)?
        .filter(|visitor| visitor.token == token && visitor.removed_at.is_none())
        .ok_or_else(not_found)?;
    match share.state() {
        ShareState::Active => {}
        ShareState::Exhausted if shares::has_opened(&visitor) => {}
        state => return Err(state_error(state)),
    }
    // A page loads its own design's files and the design system's.
    let design = path.split('/').next().unwrap_or("");
    if studio_or_repo(&share) == ProjectKind::Repo
        || !(design == crate::storage::designs::SYSTEM || scope_of(&share).allows_design(design))
    {
        return Err(not_found());
    }
    super::tasks::designs::design_file(&share.project_key, &share.task_id, &path)
        .map_err(|_| not_found())
}

/// `designs/{design}/pages/{file}`, with plain names.
fn is_design_page_path(rest: &str) -> bool {
    let parts: Vec<&str> = rest.split('/').collect();
    matches!(parts.as_slice(), ["designs", design, "pages", file]
        if crate::storage::designs::valid_name(design)
            && crate::storage::designs::valid_name(file)
            && file.to_ascii_lowercase().ends_with(".html"))
}

/// GET /api/v1/share/{token}/designs/{design}/pages/{file} — a page's HTML.
pub async fn public_design_page(
    Path((token, design, file)): Path<(String, String, String)>,
    headers: HeaderMap,
) -> Result<Response, ShareError> {
    let (share, _) = visitor_for(&headers, &token)?;
    let scope = scope_of(&share);
    let shown = if design == crate::storage::designs::SYSTEM {
        scope.all_designs()
    } else {
        scope.allows_design(&design)
    };
    if studio_or_repo(&share) == ProjectKind::Repo || !shown {
        return Err(fail(StatusCode::NOT_FOUND, "not_found", "Not found"));
    }
    let html =
        crate::storage::designs::read_page(&share.project_key, &share.task_id, &design, &file)
            .map_err(grove_error)?;
    Ok((
        [
            (header::CONTENT_TYPE, "text/plain; charset=utf-8"),
            (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
        ],
        html,
    )
        .into_response())
}

#[derive(Deserialize)]
pub struct SharedFileQuery {
    path: String,
    #[serde(default)]
    project: Option<String>,
}

/// A path inside the shared area: plain names only, no `..`, no root, no
/// git pathspec magic.
fn plain_relative(path: &str) -> bool {
    let relative = std::path::Path::new(path);
    !path.is_empty()
        && !path.starts_with(':')
        && relative
            .components()
            .all(|part| matches!(part, std::path::Component::Normal(_)))
}

/// Only files in the Task's output/ are shared, links followed included.
fn check_output_file(share: &Share, path: &str) -> Result<(), ShareError> {
    use crate::platform::CanonicalPath;
    let not_found = || fail(StatusCode::NOT_FOUND, "not_found", "File not found");
    if !plain_relative(path) || !scope_of(share).allows_file(path) {
        return Err(not_found());
    }
    let project = workspace::load_project_by_hash(&share.project_key)
        .ok()
        .flatten()
        .ok_or_else(not_found)?;
    let task_dir =
        super::tasks::artifacts::resolve_task_dir(&project, &share.project_key, &share.task_id)
            .ok_or_else(not_found)?;
    let output = task_dir
        .join("output")
        .canonical()
        .map_err(|_| not_found())?;
    let file = output.join(path).canonical().map_err(|_| not_found())?;
    if !file.starts_with(&output) || !file.is_file() {
        return Err(not_found());
    }
    Ok(())
}

/// GET /api/v1/share/{token}/files/preview?path=…
pub async fn public_file_preview(
    Path(token): Path<String>,
    headers: HeaderMap,
    Query(query): Query<SharedFileQuery>,
) -> Result<Response, ShareError> {
    let (share, _) = visitor_for(&headers, &token)?;
    if studio_or_repo(&share) == ProjectKind::Repo {
        return Err(fail(StatusCode::NOT_FOUND, "not_found", "File not found"));
    }
    check_output_file(&share, &query.path)?;
    super::tasks::preview_artifact(
        Path((share.project_key, share.task_id)),
        Query(super::tasks::ArtifactQuery {
            path: query.path,
            dir: "output".into(),
            action: None,
        }),
    )
    .await
    .map(IntoResponse::into_response)
    .map_err(|(status, Json(error))| {
        outside(status, "file", &error.error, "Couldn't open this file")
    })
}

/// GET /api/v1/share/{token}/files/download?path=…
pub async fn public_file_download(
    Path(token): Path<String>,
    headers: HeaderMap,
    Query(query): Query<SharedFileQuery>,
) -> Result<Response, ShareError> {
    let (share, _) = visitor_for(&headers, &token)?;
    if studio_or_repo(&share) == ProjectKind::Repo {
        return Err(fail(StatusCode::NOT_FOUND, "not_found", "File not found"));
    }
    check_output_file(&share, &query.path)?;
    super::tasks::download_artifact(
        Path((share.project_key, share.task_id)),
        Query(super::tasks::ArtifactQuery {
            path: query.path,
            dir: "output".into(),
            action: None,
        }),
        headers,
    )
    .await
    .map_err(|(status, Json(error))| {
        outside(status, "file", &error.error, "Couldn't open this file")
    })
}

/// GET /api/v1/share/{token}/comments — what everyone the Task was shared
/// with wrote, and the owner's answers.
pub async fn public_comments(
    Path(token): Path<String>,
    headers: HeaderMap,
    Query(review): Query<ReviewQuery>,
) -> Result<Json<Value>, ShareError> {
    let (share, visitor) = visitor_for(&headers, &token)?;
    let target = review_target(&share, review.project.as_deref())?;
    Ok(Json(shared_comments(&share, &target, &visitor)?))
}

/// The threads on `target` (the shared Task, or a linked Project's review).
fn shared_comments(
    share: &Share,
    (project, task_id): &(String, String),
    visitor: &Visitor,
) -> Result<Value, ShareError> {
    let written_by = comments::share_comment_visitors(project, task_id).map_err(grove_error)?;
    // Names of people on this Task's links: a linked Project's review has
    // visitors of this link writing in it too.
    let names =
        shares::task_visitor_names(&share.project_key, &share.task_id).map_err(grove_error)?;
    let data = comments::load_comments(project, task_id).map_err(grove_error)?;
    let own = *project == share.project_key && *task_id == share.task_id;
    let list: Vec<Value> = data
        .comments
        .into_iter()
        .filter(|comment| !own || comment_in_scope(share, comment))
        .map(|comment| {
            // The owner's comments and the agent's are shown too: everyone
            // on the link reads the same threads.
            let author_id = written_by.get(&comment.id);
            let author = author_id
                .and_then(|id| names.get(id).cloned())
                .unwrap_or_else(|| comments::build_author(&comment.agent, &comment.role));
            let anchor = matches!(comment.comment_type, comments::CommentType::File)
                .then(|| comment.anchor_text.as_deref())
                .flatten()
                .and_then(|text| serde_json::from_str::<Value>(text).ok())
                .filter(Value::is_object);
            json!({
                "id": comment.id,
                "author": author,
                "mine": author_id == Some(&visitor.id),
                "anchor": anchor,
                "commentType": comment.comment_type,
                "filePath": comment.file_path,
                "side": comment.side,
                "startLine": comment.start_line,
                "endLine": comment.end_line,
                "content": comment.content,
                "timestamp": comment.timestamp,
                "status": comment.status,
                "replies": comment.replies.iter().map(|reply| json!({
                    "id": reply.id,
                    "author": reply.agent,
                    "content": reply.content,
                    "timestamp": reply.timestamp,
                })).collect::<Vec<_>>(),
            })
        })
        .collect();
    Ok(json!({ "comments": list }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewSharedComment {
    #[serde(default)]
    comment_type: Option<String>,
    #[serde(default)]
    file_path: Option<String>,
    #[serde(default)]
    side: Option<String>,
    #[serde(default)]
    start_line: Option<u32>,
    #[serde(default)]
    end_line: Option<u32>,
    /// For a comment on a design page: the element it is about.
    #[serde(default)]
    anchor: Option<Value>,
    content: String,
}

const COMMENT_LIMIT: usize = 10_000;

/// POST /api/v1/share/{token}/comments
pub async fn public_add_comment(
    Path(token): Path<String>,
    headers: HeaderMap,
    Query(review): Query<ReviewQuery>,
    Json(input): Json<NewSharedComment>,
) -> Result<Json<Value>, ShareError> {
    let (share, visitor) = visitor_for(&headers, &token)?;
    let target = review_target(&share, review.project.as_deref())?;
    let linked = review.project.is_some();
    if !share.can_comment {
        return Err(fail(
            StatusCode::FORBIDDEN,
            "read_only",
            "This link is read-only",
        ));
    }
    let content = input.content.trim();
    if content.is_empty() || content.chars().count() > COMMENT_LIMIT {
        return Err(fail(
            StatusCode::BAD_REQUEST,
            "invalid",
            format!("A comment needs 1 to {COMMENT_LIMIT} characters"),
        ));
    }
    if let Some(path) = input.file_path.as_deref() {
        let shown = if linked {
            changed_path(&target.0, &target.1, path).await
        } else {
            shared_path(&share, path).await
        };
        if !shown {
            return Err(fail(
                StatusCode::BAD_REQUEST,
                "invalid",
                "Comments go on the files this task changed",
            ));
        }
    }
    let wants_task_comment =
        input.comment_type.as_deref() == Some("project") || input.file_path.is_none();
    if !linked && wants_task_comment && share.scope.is_some() {
        return Err(fail(
            StatusCode::BAD_REQUEST,
            "invalid",
            "Comments go on what this link shows",
        ));
    }
    let (project, task_id) = (target.0.as_str(), target.1.as_str());
    let comment = match (input.comment_type.as_deref(), input.file_path) {
        (Some("project"), _) | (_, None) => comments::add_comment(
            project,
            task_id,
            comments::CommentType::Project,
            None,
            None,
            None,
            None,
            content,
            &visitor.name,
            "",
            "",
            None,
        ),
        (Some("file"), Some(path)) => {
            let anchor = input
                .anchor
                .and_then(|anchor| super::tasks::designs::anchor_text(&anchor));
            // Kept under the path the owner's own comments on the file use.
            let path = if !linked
                && studio_or_repo(&share) == ProjectKind::Studio
                && super::tasks::designs::split_design_path(&path).is_none()
                && super::tasks::split_sketch_path(&path).is_none()
                && !path.starts_with("output/")
            {
                format!("output/{path}")
            } else {
                path
            };
            comments::add_comment(
                project,
                task_id,
                comments::CommentType::File,
                Some(path),
                None,
                None,
                None,
                content,
                &visitor.name,
                "",
                "",
                anchor,
            )
        }
        (_, Some(path)) => {
            let side = if input.side.as_deref() == Some("DELETE") {
                "DELETE"
            } else {
                "ADD"
            };
            let start = input.start_line.unwrap_or(1).max(1);
            let end = input.end_line.unwrap_or(start).max(start);
            let anchor = tasks::get_task(project, task_id)
                .ok()
                .flatten()
                .and_then(|task| {
                    if side == "DELETE" {
                        crate::git::show_file(&task.worktree_path, &task.target, &path).ok()
                    } else {
                        crate::git::read_file(&task.worktree_path, &path).ok()
                    }
                })
                .and_then(|text| comments::extract_lines(&text, start, end));
            comments::add_comment(
                project,
                task_id,
                comments::CommentType::Inline,
                Some(path),
                Some(side.into()),
                Some(start),
                Some(end),
                content,
                &visitor.name,
                "",
                "",
                anchor,
            )
        }
    }
    .map_err(grove_error)?;
    comments::set_share_visitor(project, task_id, comment.id, &visitor.id).map_err(grove_error)?;
    notify_comment(&share, &visitor, &comment);
    Ok(Json(shared_comments(&share, &target, &visitor)?))
}

#[derive(Debug, Deserialize)]
pub struct NewSharedReply {
    content: String,
}

/// POST /api/v1/share/{token}/comments/{id}/replies
///
/// A visitor answers in a thread: the owner's, the agent's or another visitor's.
pub async fn public_add_reply(
    Path((token, id)): Path<(String, u32)>,
    headers: HeaderMap,
    Query(review): Query<ReviewQuery>,
    Json(input): Json<NewSharedReply>,
) -> Result<Json<Value>, ShareError> {
    let (share, visitor) = visitor_for(&headers, &token)?;
    let target = review_target(&share, review.project.as_deref())?;
    if !share.can_comment {
        return Err(fail(
            StatusCode::FORBIDDEN,
            "read_only",
            "This link is read-only",
        ));
    }
    let content = input.content.trim();
    if content.is_empty() || content.chars().count() > COMMENT_LIMIT {
        return Err(fail(
            StatusCode::BAD_REQUEST,
            "invalid",
            format!("A reply needs 1 to {COMMENT_LIMIT} characters"),
        ));
    }
    let own = target.0 == share.project_key && target.1 == share.task_id;
    if own {
        let visible = comments::load_comments(&target.0, &target.1)
            .map_err(grove_error)?
            .comments
            .iter()
            .any(|comment| comment.id == id && comment_in_scope(&share, comment));
        if !visible {
            return Err(fail(
                StatusCode::NOT_FOUND,
                "not_found",
                "Comment not found",
            ));
        }
    }
    let found = comments::reply_comment(&target.0, &target.1, id, content, &visitor.name, "", "")
        .map_err(grove_error)?;
    if found {
        if let Some(comment) = comments::load_comments(&target.0, &target.1)
            .ok()
            .and_then(|data| data.comments.into_iter().find(|c| c.id == id))
        {
            notify_reply(&share, &visitor, &comment, content);
        }
    }
    if !found {
        return Err(fail(
            StatusCode::NOT_FOUND,
            "not_found",
            "Comment not found",
        ));
    }
    Ok(Json(shared_comments(&share, &target, &visitor)?))
}

/// Whether a file is one the link shows: a changed file, or an output file.
async fn shared_path(share: &Share, path: &str) -> bool {
    if !plain_relative(path) {
        return false;
    }
    if studio_or_repo(share) == ProjectKind::Studio {
        // A design page, a sketch, or an output file.
        let scope = scope_of(share);
        if let Some(sketch) = super::tasks::split_sketch_path(path) {
            return scope.allows_sketch(sketch)
                && super::tasks::sketch_exists(&share.project_key, &share.task_id, sketch);
        }
        if let Some((design, file)) = super::tasks::designs::split_design_path(path) {
            return scope.allows_design(design)
                && crate::storage::designs::read_page(
                    &share.project_key,
                    &share.task_id,
                    design,
                    file,
                )
                .is_ok();
        }
        return check_output_file(share, path.strip_prefix("output/").unwrap_or(path)).is_ok();
    }
    shows_own_review(share) && changed_path(&share.project_key, &share.task_id, path).await
}

/// Whether a file is one a review's changes touch.
async fn changed_path(project: &str, task_id: &str, path: &str) -> bool {
    if !plain_relative(path) {
        return false;
    }
    super::tasks::get_diff(
        Path((project.to_string(), task_id.to_string())),
        Query(super::tasks::DiffQuery {
            from_ref: None,
            to_ref: None,
        }),
    )
    .await
    .is_ok_and(|Json(diff)| {
        diff.files
            .iter()
            .any(|file| file.path == path || file.old_path.as_deref() == Some(path))
    })
}

/// Tell the owner, through the usual notifications: a banner, and the
/// Task's entry in the notification list.
fn notify_comment(share: &Share, visitor: &Visitor, comment: &comments::Comment) {
    notify(
        share,
        &format!("{} commented", visitor.name),
        comment,
        &comment.content,
    );
}

fn notify_reply(share: &Share, visitor: &Visitor, comment: &comments::Comment, reply: &str) {
    notify(share, &format!("{} replied", visitor.name), comment, reply);
}

fn notify(share: &Share, what: &str, comment: &comments::Comment, text: &str) {
    let place = match (&comment.file_path, comment.start_line) {
        (Some(path), Some(line)) => {
            let file = path.rsplit('/').next().unwrap_or(path);
            format!("{file}:{line} · ")
        }
        (Some(path), None) => format!("{} · ", path.rsplit('/').next().unwrap_or(path)),
        _ => String::new(),
    };
    let excerpt: String = text.chars().take(80).collect();
    let _ = crate::hooks::update_hook(
        &share.project_key,
        &share.task_id,
        crate::hooks::HookFact {
            kind: crate::hooks::HookKind::Comment,
            label: Some(what.to_string()),
            level: Some(crate::hooks::NotificationLevel::Notice),
            message: Some(format!("{what}: {place}{excerpt}")),
            chat_id: None,
            permission: None,
        },
    );
}

// ============================================================================
// Links this Grove opened
// ============================================================================

/// `https://host:port/s/<token>` → (link, owner's address, token).
fn parse_link(value: &str) -> Result<(String, String, String), ShareError> {
    let bad = || {
        fail(
            StatusCode::BAD_REQUEST,
            "invalid",
            "That isn't a Grove share link",
        )
    };
    let url = url::Url::parse(value.trim()).map_err(|_| bad())?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        return Err(bad());
    }
    let mut segments = url
        .path_segments()
        .ok_or_else(bad)?
        .filter(|s| !s.is_empty());
    let (Some("s"), Some(token), None) = (segments.next(), segments.next(), segments.next()) else {
        return Err(bad());
    };
    if token.is_empty() || !token.chars().all(|c| c.is_ascii_alphanumeric()) {
        return Err(bad());
    }
    let base = format!("{}://{}", url.scheme(), url.authority());
    Ok((format!("{base}/s/{token}"), base, token.to_string()))
}

fn offline() -> ShareError {
    fail(
        StatusCode::BAD_GATEWAY,
        "offline",
        "The owner's Grove can't be reached right now",
    )
}

async fn host_json(request: reqwest::RequestBuilder) -> Result<Value, ShareError> {
    let response = request.send().await.map_err(|_| offline())?;
    let status =
        StatusCode::from_u16(response.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
    // An access proxy's sign-in page, or something that isn't Grove at all.
    if response.status().is_redirection() {
        return Err(offline());
    }
    let body: Value = response.json().await.map_err(|_| offline())?;
    if status.is_success() {
        Ok(body)
    } else {
        let code = body.get("code").and_then(Value::as_str).unwrap_or("error");
        let message = body
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("The owner's Grove refused");
        Err(fail(status, code, message))
    }
}

#[derive(Deserialize)]
pub struct LinkInput {
    url: String,
}

/// POST /api/v1/shared/preview — what a link is, before opening it.
pub async fn preview_link(Json(input): Json<LinkInput>) -> Result<Json<Value>, ShareError> {
    let (url, base, token) = parse_link(&input.url)?;
    let mut info = host_json(share_client().get(format!("{base}/api/v1/share/{token}"))).await?;
    if let Some(existing) = shares::find_received_by_token(&token).map_err(grove_error)? {
        // Opened here before, maybe under another address: keep the one
        // that just answered.
        if existing.url != url {
            shares::update_received_address(&existing.id, &url, &base).map_err(grove_error)?;
        }
        info["receivedId"] = json!(existing.id);
    }
    // Links from a Grove opened here before go straight in; others ask first.
    info["knownHost"] = json!(shares::list_received()
        .map_err(grove_error)?
        .iter()
        .any(|received| received.base_url == base));
    info["url"] = json!(url);
    Ok(Json(info))
}

/// POST /api/v1/shared — open a link here, under this Grove's name.
pub async fn add_link(Json(input): Json<LinkInput>) -> Result<Json<Value>, ShareError> {
    let (url, base, token) = parse_link(&input.url)?;
    if let Some(existing) = shares::find_received_by_token(&token).map_err(grove_error)? {
        if existing.url != url {
            shares::update_received_address(&existing.id, &url, &base).map_err(grove_error)?;
        }
        return Ok(Json(received_json(&existing, None)));
    }
    let Some(name) = chosen_name() else {
        return Err(fail(
            StatusCode::CONFLICT,
            "name_required",
            "Choose the name other people see first",
        ));
    };
    let info = host_json(
        share_client()
            .post(format!("{base}/api/v1/share/{token}/join"))
            .json(&json!({
                "name": name,
                "kind": "grove",
                "device": machine_name(),
                "client": client_for(&token),
            })),
    )
    .await?;
    let credential = info
        .get("credential")
        .and_then(Value::as_str)
        .ok_or_else(offline)?;
    let text = |key: &str| {
        info.get(key)
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string()
    };
    let received = shares::save_received(shares::NewReceived {
        url: &url,
        base_url: &base,
        token: &token,
        credential,
        title: &text("title"),
        owner: &text("owner"),
        project: &text("project"),
        can_comment: info
            .get("canComment")
            .and_then(Value::as_bool)
            .unwrap_or(false),
    })
    .map_err(grove_error)?;
    let mut info = info;
    if let Some(object) = info.as_object_mut() {
        object.remove("credential");
    }
    Ok(Json(received_json(&received, Some(info))))
}

fn received_json(received: &Received, live: Option<Value>) -> Value {
    json!({
        "id": received.id,
        "url": received.url,
        "title": received.title,
        "owner": received.owner,
        "project": received.project,
        "canComment": received.can_comment,
        "addedAt": received.added_at,
        "seenAt": received.seen_at,
        "live": live,
    })
}

/// GET /api/v1/shared — every link opened here, with how each is doing.
pub async fn list_received() -> Result<Json<Value>, ShareError> {
    let all = shares::list_received().map_err(grove_error)?;
    let client = share_client();
    let checks = all.iter().map(|received| {
        let request = client
            .get(format!(
                "{}/api/v1/share/{}",
                received.base_url, received.token
            ))
            .bearer_auth(received.credential())
            .timeout(Duration::from_secs(4));
        async move { host_json(request).await }
    });
    let results = futures::future::join_all(checks).await;
    let list: Vec<Value> = all
        .iter()
        .zip(results)
        .map(|(received, result)| {
            let live = match result {
                Ok(info) => {
                    let text = |key: &str| {
                        info.get(key)
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .to_string()
                    };
                    let can_comment = info
                        .get("canComment")
                        .and_then(Value::as_bool)
                        .unwrap_or(false);
                    let working = info.get("state").and_then(Value::as_str) == Some("active");
                    if working
                        && (text("title") != received.title
                            || text("owner") != received.owner
                            || text("project") != received.project
                            || can_comment != received.can_comment)
                    {
                        let _ = shares::update_received_meta(
                            &received.id,
                            &text("title"),
                            &text("owner"),
                            &text("project"),
                            can_comment,
                        );
                    }
                    info
                }
                Err((_, Json(error))) => json!({
                    "state": error.get("code").and_then(Value::as_str).unwrap_or("offline"),
                }),
            };
            received_json(received, Some(live))
        })
        .collect();
    Ok(Json(json!({ "shares": list })))
}

fn load_received(id: &str) -> Result<Received, ShareError> {
    shares::get_received(id)
        .map_err(grove_error)?
        .ok_or_else(|| fail(StatusCode::NOT_FOUND, "not_found", "Share not found"))
}

/// DELETE /api/v1/shared/{id}
pub async fn remove_received(Path(id): Path<String>) -> Result<StatusCode, ShareError> {
    shares::delete_received(&id).map_err(grove_error)?;
    Ok(StatusCode::NO_CONTENT)
}

/// POST /api/v1/shared/{id}/seen
pub async fn mark_seen(Path(id): Path<String>) -> Result<StatusCode, ShareError> {
    shares::mark_received_seen(&id).map_err(grove_error)?;
    Ok(StatusCode::NO_CONTENT)
}

/// /api/v1/shared/{id}/host/{*rest} → the owner's /api/v1/share/{token}/{rest},
/// carrying this Grove's key.
/// `comments/<id>/replies`.
fn is_reply_path(rest: &str) -> bool {
    let mut parts = rest.split('/');
    parts.next() == Some("comments")
        && parts
            .next()
            .is_some_and(|id| !id.is_empty() && id.bytes().all(|b| b.is_ascii_digit()))
        && parts.next() == Some("replies")
        && parts.next().is_none()
}

pub async fn via_host(
    Path((id, rest)): Path<(String, String)>,
    method: Method,
    RawQuery(query): RawQuery,
    body: Bytes,
) -> Result<Response, ShareError> {
    let received = load_received(&id)?;
    let allowed = matches!(
        (method.as_str(), rest.as_str()),
        (
            "GET",
            "diff"
                | "diff/file"
                | "diff/content"
                | "files"
                | "files/preview"
                | "files/download"
                | "comments"
                | "designs"
                | "sketches"
        ) | ("POST", "open" | "comments")
    ) || (method == axum::http::Method::GET
        && (is_design_page_path(&rest) || is_sketch_scene_path(&rest)))
        || (method == axum::http::Method::POST && is_reply_path(&rest));
    if !allowed {
        return Err(fail(StatusCode::NOT_FOUND, "not_found", "Not found"));
    }
    let mut url = format!(
        "{}/api/v1/share/{}/{rest}",
        received.base_url, received.token
    );
    if let Some(query) = query {
        url.push('?');
        url.push_str(&query);
    }
    let method = reqwest::Method::from_bytes(method.as_str().as_bytes()).map_err(|_| offline())?;
    let mut request = share_stream_client()
        .request(method, url)
        .bearer_auth(received.credential());
    if !body.is_empty() {
        request = request
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .body(body.to_vec());
    }
    let upstream = request.send().await.map_err(|_| offline())?;
    if upstream.status().is_redirection() {
        return Err(offline());
    }
    let status =
        StatusCode::from_u16(upstream.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
    // What the owner's Grove sends lands on this Grove's own origin, so it
    // never comes through as something a browser would run.
    let upstream_type = upstream
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .to_ascii_lowercase();
    let content_type = if upstream_type.starts_with("application/json") {
        "application/json"
    } else if upstream_type.starts_with("text/plain") {
        "text/plain; charset=utf-8"
    } else {
        "application/octet-stream"
    };
    let mut response = Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, content_type)
        .header("x-content-type-options", "nosniff")
        .header(
            header::CONTENT_SECURITY_POLICY,
            "default-src 'none'; sandbox",
        );
    if rest == "files/download" {
        response = response.header(header::CONTENT_DISPOSITION, "attachment");
    }
    if let Some(length) = upstream.headers().get(reqwest::header::CONTENT_LENGTH) {
        response = response.header(header::CONTENT_LENGTH, length.as_bytes());
    }
    response
        .body(Body::from_stream(upstream.bytes_stream()))
        .map_err(|_| offline())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn share_links_parse() {
        let (url, base, token) = parse_link("https://grove.example.com/s/Pw4nT9cb").unwrap();
        assert_eq!(url, "https://grove.example.com/s/Pw4nT9cb");
        assert_eq!(base, "https://grove.example.com");
        assert_eq!(token, "Pw4nT9cb");
        let (_, base, _) = parse_link("http://192.168.1.9:3001/s/abc/").unwrap();
        assert_eq!(base, "http://192.168.1.9:3001");
        assert!(parse_link("https://grove.example.com/x/abc").is_err());
        assert!(parse_link("https://grove.example.com/s/abc/extra").is_err());
        assert!(parse_link("ftp://grove.example.com/s/abc").is_err());
    }

    #[test]
    fn shared_paths_stay_inside() {
        assert!(plain_relative("report.pdf"));
        assert!(plain_relative("deck/v2/slides.pdf"));
        assert!(!plain_relative(""));
        assert!(!plain_relative("../input/brief.md"));
        assert!(!plain_relative("deck/../../secret"));
        assert!(!plain_relative("/etc/passwd"));
        assert!(!plain_relative("./report.pdf"));
        assert!(!plain_relative(":(top)secret"));
    }

    #[test]
    fn addresses_normalize() {
        assert_eq!(
            normalize_address("grove.example.com/").as_deref(),
            Some("https://grove.example.com")
        );
        assert_eq!(
            normalize_address("http://192.168.1.9:3001/path").as_deref(),
            Some("http://192.168.1.9:3001")
        );
        assert_eq!(normalize_address("  "), None);
    }
}

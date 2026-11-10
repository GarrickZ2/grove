//! Looking at another machine from this one.
//!
//! Each paired machine gets a loopback port that forwards the API there,
//! signed with the pair's device key. The home window points its API at this
//! port and stays where it is, so switching machines reloads nothing, signs
//! nothing and asks for no second sign-in.
//!
//! A window reached through `grove remote` has no such loopback: it goes
//! through this server's own `/api/v1/machines/{id}/via` instead, under the
//! sign-in it already holds. Same forwarding, same stay-where-you-are.
//!
//! The person stays the same across machines, so what follows them (theme,
//! keymap, notifications, the machine list) stays on this machine, while
//! what belongs to a machine (Agents, MCP, indexing) is that machine's.

use std::collections::HashMap;
use std::sync::Arc;

use axum::body::{to_bytes, Body};
use axum::extract::{Request, State};
use axum::http::{header, HeaderValue, Method, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{any, get};
use axum::{Json, Router};
use once_cell::sync::Lazy;
use serde_json::{json, Map, Value};
use tokio::sync::Mutex;
use tokio::task::JoinHandle;
use tower::ServiceExt;
use tower_http::cors::{AllowOrigin, Any, CorsLayer};

use crate::api::{self, ProxySigner, ProxyTarget};
use crate::error::{GroveError, Result};
use crate::storage::machines as store;

/// `/config` sections that follow the person.
const PERSONAL_SECTIONS: [&str; 4] = ["theme", "layout", "hooks", "notifications"];
/// `/config` `web` fields that follow the person; the rest belong to a machine.
const PERSONAL_WEB_FIELDS: [&str; 7] = [
    "interface",
    "buddy_motion",
    "send_mode",
    "terminal_position",
    "workspace_layout",
    "show_hide_window_shortcut",
    // The way back to this machine: a machine that never turned it on must not
    // hide the switcher from the person standing on it.
    "multi_machine",
];
const CONFIG_BODY_LIMIT: usize = 4 * 1024 * 1024;
const HOME_ORIGINS: [&str; 2] = ["localhost", "127.0.0.1"];

struct Running {
    port: u16,
    server: JoinHandle<()>,
}

static RUNNING: Lazy<Mutex<HashMap<String, Running>>> = Lazy::new(Mutex::default);

#[derive(Clone)]
struct Machine {
    id: String,
    peer: Arc<ProxyTarget>,
}

/// This machine's own API, called in-process: it needs no sign-in here, and the
/// server may not be listening on loopback at all.
static HOME_API: Lazy<Router> =
    Lazy::new(|| Router::new().nest("/api/v1", api::create_api_router()));

async fn to_home(request: Request) -> Response {
    let (parts, body) = request.into_parts();
    // Without the extensions: they hold the route params of the way here.
    let mut fresh = Request::new(body);
    *fresh.method_mut() = parts.method;
    *fresh.uri_mut() = parts.uri;
    *fresh.headers_mut() = parts.headers;
    match HOME_API.clone().oneshot(fresh).await {
        Ok(response) => response,
        Err(never) => match never {},
    }
}

async fn to_peer(machine: &Machine, request: Request) -> Response {
    api::http_proxy_handler(State(machine.peer.clone()), request).await
}

/// Overlay the personal parts of `personal` on `machine`.
fn merge_config(personal: &Value, mut machine: Value) -> Value {
    let Some(target) = machine.as_object_mut() else {
        return machine;
    };
    for section in PERSONAL_SECTIONS {
        if let Some(value) = personal.get(section) {
            target.insert(section.to_string(), value.clone());
        }
    }
    if let Some(web) = target.get_mut("web").and_then(Value::as_object_mut) {
        for field in PERSONAL_WEB_FIELDS {
            if let Some(value) = personal.pointer(&format!("/web/{field}")) {
                web.insert(field.to_string(), value.clone());
            }
        }
    }
    machine
}

/// Split a `/config` patch into (personal, machine) parts.
fn split_patch(patch: Value) -> (Map<String, Value>, Map<String, Value>) {
    let mut personal = Map::new();
    let mut machine = Map::new();
    let Value::Object(fields) = patch else {
        return (personal, machine);
    };
    for (key, value) in fields {
        if PERSONAL_SECTIONS.contains(&key.as_str()) {
            personal.insert(key, value);
        } else if let ("web", Value::Object(web)) = (key.as_str(), &value) {
            let (mine, theirs): (Map<_, _>, Map<_, _>) = web
                .clone()
                .into_iter()
                .partition(|(field, _)| PERSONAL_WEB_FIELDS.contains(&field.as_str()));
            if !mine.is_empty() {
                personal.insert(key.clone(), Value::Object(mine));
            }
            if !theirs.is_empty() {
                machine.insert(key, Value::Object(theirs));
            }
        } else {
            machine.insert(key, value);
        }
    }
    (personal, machine)
}

fn config_request(method: Method, body: Option<Value>) -> Request {
    let builder = Request::builder()
        .method(method)
        .uri("/api/v1/config")
        .header(header::CONTENT_TYPE, "application/json");
    let body = body.map_or_else(Body::empty, |value| Body::from(value.to_string()));
    builder.body(body).expect("config request")
}

async fn config_json(response: Response) -> std::result::Result<Value, Box<Response>> {
    if !response.status().is_success() {
        return Err(Box::new(response));
    }
    let bad_gateway = |_| Box::new(StatusCode::BAD_GATEWAY.into_response());
    let bytes = to_bytes(response.into_body(), CONFIG_BODY_LIMIT)
        .await
        .map_err(|_| Box::new(StatusCode::BAD_GATEWAY.into_response()))?;
    serde_json::from_slice(&bytes).map_err(bad_gateway)
}

async fn merged(machine: &Machine) -> Response {
    let personal = match config_json(to_home(config_request(Method::GET, None)).await).await {
        Ok(value) => value,
        Err(response) => return *response,
    };
    match config_json(to_peer(machine, config_request(Method::GET, None)).await).await {
        Ok(theirs) => Json(merge_config(&personal, theirs)).into_response(),
        Err(response) => *response,
    }
}

fn patch_request(part: Map<String, Value>) -> Option<Request> {
    (!part.is_empty()).then(|| config_request(Method::PATCH, Some(Value::Object(part))))
}

fn failed(response: Response) -> Option<Response> {
    (!response.status().is_success()).then_some(response)
}

async fn config(State(machine): State<Machine>, request: Request) -> Response {
    if request.method() == Method::GET {
        return merged(&machine).await;
    }
    if request.method() != Method::PATCH {
        return StatusCode::METHOD_NOT_ALLOWED.into_response();
    }
    let Ok(bytes) = to_bytes(request.into_body(), CONFIG_BODY_LIMIT).await else {
        return StatusCode::PAYLOAD_TOO_LARGE.into_response();
    };
    let Ok(patch) = serde_json::from_slice::<Value>(&bytes) else {
        return StatusCode::BAD_REQUEST.into_response();
    };
    let (personal, theirs) = split_patch(patch);
    if let Some(request) = patch_request(personal) {
        if let Some(response) = failed(to_home(request).await) {
            return response;
        }
    }
    if let Some(request) = patch_request(theirs) {
        if let Some(response) = failed(to_peer(&machine, request).await) {
            return response;
        }
    }
    merged(&machine).await
}

/// The window is already authorized by being here; the frontend must not
/// show a sign-in, and treats the server as remote.
async fn auth_info() -> Json<Value> {
    Json(json!({
        "required": false,
        "remote": true,
        "device_sessions": true,
        "trusted_devices": false,
        "trusted_device_cookies": false,
    }))
}

async fn machines(State(machine): State<Machine>, request: Request) -> Response {
    if request.method() == Method::GET {
        return match super::overview(Some(&machine.id)) {
            Ok(overview) => Json(overview).into_response(),
            Err(error) => (StatusCode::INTERNAL_SERVER_ERROR, error.to_string()).into_response(),
        };
    }
    to_home(request).await
}

async fn at_home(request: Request) -> Response {
    to_home(request).await
}

fn is_loopback(host: &HeaderValue) -> bool {
    let host = host.to_str().unwrap_or_default();
    let name = host.rsplit_once(':').map_or(host, |(name, _)| name);
    matches!(name, "localhost" | "127.0.0.1")
}

/// The home window, which points its API here.
fn from_home(origin: &str, home_port: u16) -> bool {
    HOME_ORIGINS
        .iter()
        .any(|host| origin == format!("http://{host}:{home_port}"))
}

/// This port signs with a real key, so only this machine's own pages may use
/// its API: a loopback Host stops DNS rebinding, and the request must come from
/// the home window or this port. Pages stay open. Plugin assets are token-gated
/// and load from opaque origins.
async fn only_this_origin(mut request: Request, next: Next) -> Response {
    if !guarded(request.uri().path()) {
        return next.run(request).await;
    }
    let loopback = request.headers().get(header::HOST).is_some_and(is_loopback);
    let home = request
        .headers()
        .get(header::ORIGIN)
        .and_then(|origin| origin.to_str().ok())
        .is_some_and(|origin| from_home(origin, super::home_port()));
    if home {
        // Vouched for here; the far machine would read these as another site.
        let headers = request.headers_mut();
        headers.remove(header::ORIGIN);
        headers.remove(header::REFERER);
        headers.remove("sec-fetch-site");
    }
    if loopback && (home || api::csrf::same_origin_browser_request(&request)) {
        next.run(request).await
    } else {
        (StatusCode::FORBIDDEN, "Cross-origin request blocked").into_response()
    }
}

/// Plugin panels are framed by the home window, which is another origin to this
/// port. Their sandbox stays; only the frame's parent changes.
async fn frame_plugin_assets_at_home(request: Request, next: Next) -> Response {
    let assets = request.uri().path().starts_with("/api/v1/plugin-assets/");
    let mut response = next.run(request).await;
    if assets {
        allow_home_framing(response.headers_mut(), super::home_port());
    }
    response
}

fn allow_home_framing(headers: &mut header::HeaderMap, home_port: u16) {
    let ancestors = HOME_ORIGINS.map(|host| format!("http://{host}:{home_port}"));
    let policy = format!(
        "sandbox allow-scripts; frame-ancestors {}",
        ancestors.join(" ")
    );
    if let Ok(policy) = HeaderValue::from_str(&policy) {
        headers.remove(header::X_FRAME_OPTIONS);
        headers.insert(header::CONTENT_SECURITY_POLICY, policy);
    }
}

fn guarded(path: &str) -> bool {
    (path.starts_with("/api/") || path == "/ws")
        && !path.starts_with("/api/v1/plugin-assets/")
        && !path.starts_with("/api/v1/design-files/")
}

/// What a machine's API looks like from here, wherever a window reaches it from.
fn forwarding(machine: Machine) -> Router {
    let peer = machine.peer.clone();
    let personal = Router::new()
        .route("/api/v1/auth/info", get(auth_info))
        .route("/api/v1/config", any(config))
        .route("/api/v1/machines", any(machines))
        .route("/api/v1/machines/{*rest}", any(at_home))
        .route("/api/v1/keymap", any(at_home))
        .route("/api/v1/keymap/{*rest}", any(at_home))
        .with_state(machine);
    personal.merge(api::proxy_router(peer))
}

fn router(machine: Machine) -> Router {
    let static_dir = (!api::has_embedded_assets())
        .then(api::find_static_dir)
        .flatten();
    let home = HOME_ORIGINS.map(|host| format!("http://{host}:{}", super::home_port()));
    let cors = CorsLayer::new()
        .allow_origin(AllowOrigin::list(
            home.iter()
                .filter_map(|origin| origin.parse::<HeaderValue>().ok()),
        ))
        .allow_methods(Any)
        .allow_headers(Any)
        .expose_headers(Any);
    api::with_frontend(forwarding(machine), static_dir)
        .layer(middleware::from_fn(only_this_origin))
        .layer(middleware::from_fn(frame_plugin_assets_at_home))
        .layer(cors)
}

fn target_for(peer: &store::Peer) -> Result<Arc<ProxyTarget>> {
    let url = peer
        .url
        .clone()
        .ok_or_else(|| GroveError::invalid_data("This machine connects to you; open it there"))?;
    Ok(Arc::new(ProxyTarget {
        url,
        signer: Some(ProxySigner {
            authorization: super::authorization(peer),
            headers: peer
                .headers
                .iter()
                .map(|(name, value)| (name.clone(), value.clone()))
                .collect(),
        }),
    }))
}

/// What `/machines/{id}/via` forwards to, kept until the machine changes.
static VIA: Lazy<std::sync::Mutex<HashMap<String, Router>>> = Lazy::new(Default::default);

fn via_router(id: &str) -> Result<Router> {
    let mut routers = VIA.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(router) = routers.get(id) {
        return Ok(router.clone());
    }
    let peer = store::peer(id)?.ok_or_else(|| GroveError::not_found("Machine not found"))?;
    let router = forwarding(Machine {
        id: id.to_string(),
        peer: target_for(&peer)?,
    });
    routers.insert(id.to_string(), router.clone());
    Ok(router)
}

/// The request as the machine should see it, without the `via` prefix.
fn forwarded_uri(uri: &axum::http::Uri, id: &str) -> Option<axum::http::Uri> {
    uri.path_and_query()?
        .as_str()
        .strip_prefix(&format!("/machines/{id}/via"))?
        .parse()
        .ok()
}

/// Forward a request that came in through `/machines/{id}/via`.
pub async fn via(id: &str, mut request: Request) -> Result<Response> {
    let router = via_router(id)?;
    let uri = forwarded_uri(request.uri(), id)
        .ok_or_else(|| GroveError::invalid_data("Bad machine path"))?;
    *request.uri_mut() = uri;
    match router.oneshot(request).await {
        Ok(response) => Ok(response),
        Err(never) => match never {},
    }
}

/// The API base for a window on this machine, starting its port if needed.
pub async fn open(id: &str) -> Result<String> {
    if !super::switchable() {
        let _ = via_router(id)?;
        return Ok(format!("/api/v1/machines/{id}/via"));
    }
    let mut running = RUNNING.lock().await;
    if let Some(existing) = running.get(id).filter(|proxy| !proxy.server.is_finished()) {
        return Ok(format!("http://localhost:{}", existing.port));
    }
    let peer = store::peer(id)?.ok_or_else(|| GroveError::not_found("Machine not found"))?;
    let machine = Machine {
        id: id.to_string(),
        peer: target_for(&peer)?,
    };
    let listener = match peer.proxy_port {
        Some(port) => match tokio::net::TcpListener::bind(("127.0.0.1", port)).await {
            Ok(listener) => listener,
            Err(_) => tokio::net::TcpListener::bind(("127.0.0.1", 0)).await?,
        },
        None => tokio::net::TcpListener::bind(("127.0.0.1", 0)).await?,
    };
    let port = listener.local_addr()?.port();
    if peer.proxy_port != Some(port) {
        store::update_peer(id, |peer| peer.proxy_port = Some(port))?;
    }
    let app = router(machine);
    let server = tokio::spawn(async move {
        if let Err(error) = axum::serve(listener, app).await {
            eprintln!("[Grove] machine proxy stopped: {error}");
        }
    });
    running.insert(id.to_string(), Running { port, server });
    Ok(format!("http://localhost:{port}"))
}

/// Stop serving a machine: it was unpaired, or its credentials changed.
pub async fn close(id: &str) {
    VIA.lock().unwrap_or_else(|e| e.into_inner()).remove(id);
    if let Some(proxy) = RUNNING.lock().await.remove(id) {
        proxy.server.abort();
        // Its port is free once the task is gone, so reopening can reuse it.
        let _ = proxy.server.await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn via_keeps_the_path_and_query_as_sent() {
        let uri = "/machines/abc/via/api/v1/files%2Fa?ts=1&sig=x"
            .parse()
            .unwrap();
        assert_eq!(
            forwarded_uri(&uri, "abc").unwrap().to_string(),
            "/api/v1/files%2Fa?ts=1&sig=x"
        );
        let other = "/machines/other/via/ws".parse().unwrap();
        assert!(forwarded_uri(&other, "abc").is_none());
    }

    #[test]
    fn plugin_panels_frame_at_home_and_stay_sandboxed() {
        let mut headers = header::HeaderMap::new();
        headers.insert(
            header::X_FRAME_OPTIONS,
            HeaderValue::from_static("SAMEORIGIN"),
        );
        headers.insert(
            header::CONTENT_SECURITY_POLICY,
            HeaderValue::from_static("sandbox allow-scripts; frame-ancestors 'self'"),
        );
        allow_home_framing(&mut headers, 3001);
        assert!(headers.get(header::X_FRAME_OPTIONS).is_none());
        assert_eq!(
            headers[header::CONTENT_SECURITY_POLICY],
            "sandbox allow-scripts; frame-ancestors http://localhost:3001 http://127.0.0.1:3001"
        );
    }

    #[test]
    fn personal_settings_win_and_machine_settings_stay() {
        let personal = json!({
            "theme": {"name": "mine"},
            "notifications": {"tray_enabled": false},
            "web": {"interface": "orbit", "ide": "my-ide"},
            "acp": {"agent_command": "mine"},
        });
        let machine = json!({
            "theme": {"name": "theirs"},
            "web": {"interface": "workbench", "ide": "their-ide", "terminal": "kitty"},
            "acp": {"agent_command": "theirs"},
            "platform": "linux",
        });
        assert_eq!(
            merge_config(&personal, machine),
            json!({
                "theme": {"name": "mine"},
                "notifications": {"tray_enabled": false},
                "web": {"interface": "orbit", "ide": "their-ide", "terminal": "kitty"},
                "acp": {"agent_command": "theirs"},
                "platform": "linux",
            })
        );
    }

    #[test]
    fn the_machine_switcher_follows_the_person_onto_any_machine() {
        let merged = merge_config(
            &json!({"web":{"multi_machine":true,"terminal_position":"left"}}),
            json!({"web":{"multi_machine":false,"terminal_position":"bottom"}}),
        );
        assert_eq!(merged["web"]["multi_machine"], true);
        assert_eq!(merged["web"]["terminal_position"], "left");

        let older = merge_config(&json!({"web":{"multi_machine":true}}), json!({"web":{}}));
        assert_eq!(older["web"]["multi_machine"], true);

        let (personal, machine) = split_patch(json!({"web":{"multi_machine":false}}));
        assert_eq!(personal["web"]["multi_machine"], false);
        assert!(machine.is_empty());
    }

    #[test]
    fn a_patch_splits_by_who_owns_each_field() {
        let (personal, machine) = split_patch(json!({
            "theme": {"name": "new"},
            "web": {"interface": "orbit", "ide": "zed"},
            "acp": {"agent_command": "x"},
        }));
        assert_eq!(
            Value::Object(personal),
            json!({"theme": {"name": "new"}, "web": {"interface": "orbit"}})
        );
        assert_eq!(
            Value::Object(machine),
            json!({"web": {"ide": "zed"}, "acp": {"agent_command": "x"}})
        );
    }

    #[test]
    fn a_patch_touching_one_side_leaves_the_other_empty() {
        let (personal, machine) = split_patch(json!({"web": {"send_mode": "enter"}}));
        assert!(!personal.is_empty());
        assert!(machine.is_empty());
    }

    #[test]
    fn the_api_is_guarded_and_pages_are_not() {
        assert!(guarded("/api/v1/projects"));
        assert!(guarded("/ws"));
        assert!(!guarded("/"));
        assert!(!guarded("/assets/index.js"));
        assert!(!guarded("/api/v1/plugin-assets/token/id/index.js"));
    }

    #[test]
    fn only_the_home_window_counts_as_home() {
        assert!(from_home("http://localhost:3001", 3001));
        assert!(from_home("http://127.0.0.1:3001", 3001));
        assert!(!from_home("http://localhost:3002", 3001));
        assert!(!from_home("http://evil.example", 3001));
    }

    #[test]
    fn only_loopback_hosts_count() {
        assert!(is_loopback(&HeaderValue::from_static("localhost:4100")));
        assert!(is_loopback(&HeaderValue::from_static("127.0.0.1:4100")));
        assert!(!is_loopback(&HeaderValue::from_static("evil.test:4100")));
        assert!(!is_loopback(&HeaderValue::from_static(
            "localhost.evil.test"
        )));
    }
}

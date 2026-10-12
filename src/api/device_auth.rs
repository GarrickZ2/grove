//! Revocable device HMAC sessions and HTTPS-only remembered-device cookies.

use axum::{
    extract::{
        ws::{WebSocket, WebSocketUpgrade},
        FromRequestParts, Path, Query, State,
    },
    http::{header, request::Parts, HeaderMap, StatusCode},
    middleware::Next,
    response::{IntoResponse, Response},
    Extension, Json,
};
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::{
    future::Future,
    sync::{atomic::Ordering, Arc},
};

use super::auth::{RequestSignature, ServerAuth};
use crate::storage::auth_devices::{self, Device};

type HmacSha256 = Hmac<sha2::Sha256>;
const COOKIE: &str = "__Host-grove_device";
// Cookie persistence only; authorizations have no server-side expiration.
// Refreshing a trusted session renews browser cookie retention.
const COOKIE_MAX_AGE: i64 = i32::MAX as i64;

#[derive(Clone)]
pub(crate) struct RequestAuth {
    device: Option<DeviceSession>,
}

impl RequestAuth {
    pub(crate) fn master() -> Self {
        Self { device: None }
    }
    pub(crate) fn id(&self) -> Option<&str> {
        self.device.as_ref().map(|d| d.id.as_str())
    }
}

#[derive(Clone)]
struct DeviceSession {
    id: String,
    scope: String,
    changes: tokio::sync::watch::Receiver<u64>,
    database_changes: Option<tokio::sync::watch::Receiver<u64>>,
}

impl DeviceSession {
    async fn revoked(mut self) {
        let Some(mut database_changes) = self.database_changes.take() else {
            return;
        };
        loop {
            // Read persistent state as well: another Grove process may revoke
            // a device sharing the same password. Fail closed on storage errors.
            if !matches!(auth_devices::get(&self.scope, &self.id), Ok(Some(_))) {
                return;
            }
            tokio::select! {
                changed = self.changes.changed() => { if changed.is_err() { return; } },
                changed = database_changes.changed() => { if changed.is_err() { return; } },
            }
        }
    }
}

impl ServerAuth {
    fn cookie_name(&self) -> &str {
        self.device_cookie_name.get().map_or(COOKIE, String::as_str)
    }

    fn cookie_value<'a>(&self, headers: &'a HeaderMap) -> Option<&'a str> {
        headers
            .get(header::COOKIE)?
            .to_str()
            .ok()?
            .split(';')
            .filter_map(|part| part.trim().split_once('='))
            .find_map(|(name, value)| (name == self.cookie_name()).then_some(value))
    }

    pub(crate) fn cookie_device_id<'a>(&self, headers: &'a HeaderMap) -> Option<&'a str> {
        let (id, _) = self.cookie_value(headers)?.split_once('.')?;
        valid_id(id).then_some(id)
    }

    pub(crate) fn device_is_active(&self, id: &str) -> bool {
        valid_id(id)
            && self.secret_key.is_some()
            && matches!(auth_devices::get(&self.scope(), id), Ok(Some(_)))
    }
    fn keyed_value(&self, message: &str) -> String {
        let mut mac =
            HmacSha256::new_from_slice(self.secret_key.as_deref().unwrap_or("").as_bytes())
                .expect("HMAC key");
        mac.update(message.as_bytes());
        hex::encode(mac.finalize().into_bytes())
    }

    fn scope(&self) -> String {
        self.device_scope
            .get()
            .cloned()
            .unwrap_or_else(|| self.keyed_value("grove-device-scope-v1"))
    }

    pub(crate) fn device_scope(&self) -> String {
        self.scope()
    }

    pub(crate) fn initialize_device_auth(
        &self,
        address: std::net::SocketAddr,
    ) -> crate::error::Result<()> {
        if self.secret_key.is_none() || self.device_scope.get().is_some() {
            return Ok(());
        }
        let server = address.to_string();
        let scope = auth_devices::activate_server(
            &server,
            &self.keyed_value("grove-device-scope-v1"),
            &super::auth::generate_secret_key(),
        )?;
        // Cookies are shared across a host's ports. Give each listening
        // instance a stable name so its login/logout cannot overwrite another.
        self.device_cookie_name
            .set(format!(
                "{}_{}",
                COOKIE,
                hex::encode(Sha256::digest(server.as_bytes()))
            ))
            .expect("device cookie initialized once");
        self.device_scope
            .set(scope)
            .expect("device auth initialized once");
        Ok(())
    }

    fn identity(self: &Arc<Self>, id: &str) -> RequestAuth {
        RequestAuth {
            device: Some(DeviceSession {
                id: id.to_owned(),
                scope: self.scope(),
                changes: self.device_changes.subscribe(),
                database_changes: auth_devices::subscribe_to_changes()
                    .map_err(|error| eprintln!("[auth] database notifications: {error}"))
                    .ok(),
            }),
        }
    }

    pub(crate) fn authenticate_signature(
        self: &Arc<Self>,
        id: Option<&str>,
        signature: RequestSignature<'_>,
    ) -> Option<RequestAuth> {
        if let Some(id) = id {
            let device = auth_devices::get(&self.scope(), id).ok()??;
            if device.token_hash.is_some() {
                return None;
            }
            let key = self.keyed_value(&format!("grove-device-key-v1|{}", id));
            self.verify_signature_with_key(&key, signature)
                .then(|| self.identity(id))
        } else {
            self.verify_signature(
                signature.timestamp,
                signature.nonce,
                signature.method,
                signature.path,
                signature.signature,
            )
            .then(RequestAuth::master)
        }
    }

    pub(crate) fn authenticate_cookie(
        self: &Arc<Self>,
        headers: &HeaderMap,
    ) -> Option<RequestAuth> {
        if !self.secure_cookies.load(Ordering::Relaxed) {
            return None;
        }
        let value = self.cookie_value(headers)?;
        let (id, token) = value.split_once('.')?;
        if !valid_id(id) || !valid_id(token) {
            return None;
        }
        let device = auth_devices::get(&self.scope(), id).ok()??;
        if !device.trusted {
            return None;
        }
        let hash = hex::decode(device.token_hash?).ok()?;
        let mut mac = HmacSha256::new_from_slice(self.secret_key.as_deref()?.as_bytes()).ok()?;
        mac.update(format!("grove-device-cookie-v1|{}|{}", id, token).as_bytes());
        mac.verify_slice(&hash).ok()?;
        Some(self.identity(id))
    }

    fn notify_revocation(&self) {
        self.device_changes
            .send_modify(|version| *version = version.wrapping_add(1));
    }
}

fn valid_id(id: &str) -> bool {
    id.len() == 64 && id.bytes().all(|b| b.is_ascii_hexdigit())
}
fn storage_error(error: crate::error::GroveError) -> StatusCode {
    eprintln!("[auth] device storage: {}", error);
    StatusCode::INTERNAL_SERVER_ERROR
}

fn clean_name(value: &str) -> Option<String> {
    let name = value.trim();
    (!name.is_empty() && name.chars().count() <= 80 && !name.chars().any(char::is_control))
        .then(|| name.to_owned())
}

fn client_label(headers: &HeaderMap, standalone: bool) -> String {
    let ua = headers
        .get(header::USER_AGENT)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    let platform = if ua.contains("iPhone") {
        "iPhone"
    } else if ua.contains("iPad") {
        "iPad"
    } else if ua.contains("Android") {
        "Android"
    } else if ua.contains("Macintosh") {
        "Mac"
    } else if ua.contains("Windows") {
        "Windows"
    } else if ua.contains("Linux") {
        "Linux"
    } else {
        "Browser"
    };
    let browser = if standalone {
        "Grove app"
    } else if ua.contains("Edg") {
        "Edge"
    } else if ua.contains("Chrome") || ua.contains("CriOS") {
        "Chrome"
    } else if ua.contains("Firefox") || ua.contains("FxiOS") {
        "Firefox"
    } else if ua.contains("Safari") {
        "Safari"
    } else {
        "Web"
    };
    format!("{} · {}", platform, browser)
}

#[derive(Deserialize)]
pub(crate) struct LoginQuery {
    device_id: String,
    previous_device_id: Option<String>,
    browser_id: Option<String>,
    #[serde(default)]
    trusted: bool,
    cookie: Option<bool>,
}
#[derive(Deserialize)]
pub(crate) struct LoginRequest {
    name: Option<String>,
    #[serde(default)]
    standalone: bool,
}

/// Fresh master-key signature authorizes a new device. The ID and trust choice
/// are in the signed query; a captured static /auth/verify proof cannot mint one.
pub(crate) async fn login(
    State(auth): State<Arc<ServerAuth>>,
    Extension(identity): Extension<RequestAuth>,
    Query(query): Query<LoginQuery>,
    headers: HeaderMap,
    Json(request): Json<LoginRequest>,
) -> Result<Response, StatusCode> {
    if auth.secret_key.is_none() || identity.id().is_some() {
        return Err(StatusCode::FORBIDDEN);
    }
    if !valid_id(&query.device_id) {
        return Err(StatusCode::BAD_REQUEST);
    }
    if query
        .previous_device_id
        .as_ref()
        .is_some_and(|id| !valid_id(id))
    {
        return Err(StatusCode::BAD_REQUEST);
    }
    let cookie = query
        .cookie
        .unwrap_or(query.trusted && auth.secure_cookies.load(Ordering::Relaxed));
    if cookie && (!query.trusted || !auth.secure_cookies.load(Ordering::Relaxed)) {
        return Err(StatusCode::BAD_REQUEST);
    }
    if query.browser_id.as_deref().is_some_and(|id| !valid_id(id)) {
        return Err(StatusCode::BAD_REQUEST);
    }
    let client = client_label(&headers, request.standalone);
    let name = match request.name {
        Some(name) => clean_name(&name).ok_or(StatusCode::BAD_REQUEST)?,
        None => auth_devices::list(&auth.scope())
            .map_err(storage_error)?
            .into_iter()
            .find(|device| query.browser_id.as_deref() == Some(device.browser_id()))
            .map_or_else(|| client.clone(), |device| device.name),
    };
    let now = chrono::Utc::now().timestamp();
    let token = cookie.then(super::auth::generate_secret_key);
    let device = Device {
        id: query.device_id.clone(),
        browser_id: query.browser_id,
        name,
        client,
        trusted: query.trusted,
        created_at: now,
        last_used_at: now,
        token_hash: token.as_ref().map(|token| {
            auth.keyed_value(&format!(
                "grove-device-cookie-v1|{}|{}",
                query.device_id, token
            ))
        }),
    };
    // Rotate only the authorization this tab is replacing. Other tabs retain
    // separate temporary credentials but share one managed browser identity.
    let mut replaced_ids: Vec<String> = query.previous_device_id.into_iter().collect();
    if let Some(old) = auth
        .authenticate_cookie(&headers)
        .and_then(|identity| identity.id().map(str::to_owned))
    {
        replaced_ids.push(old);
    }
    auth_devices::insert(&auth.scope(), &device, &replaced_ids).map_err(storage_error)?;
    if !replaced_ids.is_empty() {
        auth.notify_revocation();
    }
    let mut response = Json(device.clone()).into_response();
    if let Some(token) = token {
        response.headers_mut().insert(
            header::SET_COOKIE,
            format!(
                "{}={}.{}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age={}",
                auth.cookie_name(),
                device.id,
                token,
                COOKIE_MAX_AGE
            )
            .parse()
            .expect("cookie header"),
        );
    } else {
        clear_cookie(&auth, &mut response);
    }
    Ok(response)
}

#[derive(Deserialize)]
pub(crate) struct SessionQuery {
    browser_id: Option<String>,
}

pub(crate) async fn bound_session(
    State(auth): State<Arc<ServerAuth>>,
    Extension(identity): Extension<RequestAuth>,
    Query(query): Query<SessionQuery>,
    headers: HeaderMap,
) -> Result<Response, StatusCode> {
    if let Some(browser_id) = query.browser_id {
        if !valid_id(&browser_id) {
            return Err(StatusCode::BAD_REQUEST);
        }
        if let Some(id) = identity.id() {
            // Adopt authorizations created before browser identities existed.
            // The identity is in the signed query, never an unsigned header.
            auth_devices::bind_browser(&auth.scope(), id, &browser_id).map_err(storage_error)?;
        }
    }
    session(State(auth), Extension(identity), headers).await
}

async fn session(
    State(auth): State<Arc<ServerAuth>>,
    Extension(identity): Extension<RequestAuth>,
    headers: HeaderMap,
) -> Result<Response, StatusCode> {
    let device = identity
        .id()
        .map(|id| auth_devices::get(&auth.scope(), id))
        .transpose()
        .map_err(storage_error)?
        .flatten();
    if identity.id().is_some() && device.is_none() {
        return Err(StatusCode::UNAUTHORIZED);
    }
    let mut response =
        Json(json!({ "device": device, "required": auth.secret_key.is_some() })).into_response();
    // Renew browser retention without assigning a lifetime to the authorization.
    if let Some(cookie_identity) = auth.authenticate_cookie(&headers) {
        if cookie_identity.id() == identity.id() {
            if let Some(cookie) = auth.cookie_value(&headers) {
                response.headers_mut().insert(
                    header::SET_COOKIE,
                    format!(
                        "{}={}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age={}",
                        auth.cookie_name(),
                        cookie,
                        COOKIE_MAX_AGE
                    )
                    .parse()
                    .expect("cookie header"),
                );
            }
        }
    }
    Ok(response)
}

#[derive(Deserialize)]
pub(crate) struct TrustQuery {
    cookie: Option<bool>,
}

/// Remember a QR/tab authorization. Cookie upgrades rotate the device ID;
/// signed sessions retain their existing device key without transmitting it.
pub(crate) async fn trust(
    State(auth): State<Arc<ServerAuth>>,
    Extension(identity): Extension<RequestAuth>,
    Query(query): Query<TrustQuery>,
    headers: HeaderMap,
) -> Result<Response, StatusCode> {
    let cookie = query
        .cookie
        .unwrap_or(auth.secure_cookies.load(Ordering::Relaxed));
    if cookie && !auth.secure_cookies.load(Ordering::Relaxed) {
        return Err(StatusCode::BAD_REQUEST);
    }
    let old_id = identity.id().ok_or(StatusCode::FORBIDDEN)?;
    let mut device = auth_devices::get(&auth.scope(), old_id)
        .map_err(storage_error)?
        .ok_or(StatusCode::UNAUTHORIZED)?;
    if !cookie {
        device.trusted = true;
        if !auth_devices::trust_signed_session(&auth.scope(), old_id).map_err(storage_error)? {
            return Err(StatusCode::BAD_REQUEST);
        }
        return Ok(Json(device).into_response());
    }
    let mut replaced_ids = vec![old_id.to_owned()];
    if let Some(cookie) = auth
        .authenticate_cookie(&headers)
        .and_then(|identity| identity.id().map(str::to_owned))
    {
        replaced_ids.push(cookie);
    }
    device.id = super::auth::generate_secret_key();
    let token = super::auth::generate_secret_key();
    device.trusted = true;
    device.token_hash =
        Some(auth.keyed_value(&format!("grove-device-cookie-v1|{}|{}", device.id, token)));
    auth_devices::insert(&auth.scope(), &device, &replaced_ids).map_err(storage_error)?;
    auth.notify_revocation();
    let mut response = Json(device.clone()).into_response();
    response.headers_mut().insert(
        header::SET_COOKIE,
        format!(
            "{}={}.{}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age={}",
            auth.cookie_name(),
            device.id,
            token,
            COOKIE_MAX_AGE
        )
        .parse()
        .expect("cookie header"),
    );
    Ok(response)
}

#[derive(Serialize)]
struct ListedDevice {
    #[serde(flatten)]
    device: Device,
    #[serde(skip_serializing_if = "Option::is_none")]
    port: Option<u16>,
}

pub(crate) async fn list(
    State(auth): State<Arc<ServerAuth>>,
    Extension(identity): Extension<RequestAuth>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    let ports = auth_devices::server_ports().map_err(storage_error)?;
    let records = if auth.secret_key.is_some() {
        let scope = auth.scope();
        auth_devices::list(&scope)
            .map_err(storage_error)?
            .into_iter()
            .map(|device| (scope.clone(), device))
            .collect()
    } else {
        auth_devices::list_all().map_err(storage_error)?
    };
    let mut devices: Vec<ListedDevice> = Vec::new();
    let mut grouped = std::collections::HashMap::new();
    let mut current_id = None;
    for (scope, mut device) in records {
        let browser_id = device.browser_id().to_owned();
        let id = if auth.secret_key.is_some() {
            browser_id.clone()
        } else {
            auth.device_management_id(&scope, &browser_id)
        };
        if identity.id() == Some(device.id.as_str()) {
            current_id = Some(id.clone());
        }
        if let Some(&index) = grouped.get(&(scope.clone(), browser_id.clone())) {
            let existing: &mut ListedDevice = &mut devices[index];
            existing.device.trusted |= device.trusted;
            existing.device.created_at = existing.device.created_at.min(device.created_at);
            existing.device.last_used_at = existing.device.last_used_at.max(device.last_used_at);
        } else {
            grouped.insert((scope.clone(), browser_id), devices.len());
            device.id = id;
            devices.push(ListedDevice {
                device,
                port: ports.get(&scope).copied(),
            });
        }
    }
    Ok(Json(
        json!({ "devices": devices, "current_device_id": current_id, "required": auth.secret_key.is_some() }),
    ))
}

fn management_target(auth: &ServerAuth, id: &str) -> Result<(String, String), StatusCode> {
    if !valid_id(id) {
        return Err(StatusCode::BAD_REQUEST);
    }
    if auth.secret_key.is_some() {
        return Ok((auth.scope(), id.to_owned()));
    }
    auth_devices::list_all()
        .map_err(storage_error)?
        .into_iter()
        .find_map(|(scope, device)| {
            let browser_id = device.browser_id().to_owned();
            (auth.device_management_id(&scope, &browser_id) == id).then_some((scope, browser_id))
        })
        .ok_or(StatusCode::NOT_FOUND)
}

#[derive(Deserialize)]
pub(crate) struct RenameRequest {
    name: String,
}
pub(crate) async fn rename(
    State(auth): State<Arc<ServerAuth>>,
    Path(id): Path<String>,
    Json(request): Json<RenameRequest>,
) -> Result<StatusCode, StatusCode> {
    let name = clean_name(&request.name).ok_or(StatusCode::BAD_REQUEST)?;
    let (scope, id) = management_target(&auth, &id)?;
    if !auth_devices::rename(&scope, &id, &name).map_err(storage_error)? {
        return Err(StatusCode::NOT_FOUND);
    }
    Ok(StatusCode::NO_CONTENT)
}

fn clear_cookie(auth: &ServerAuth, response: &mut Response) {
    response.headers_mut().insert(
        header::SET_COOKIE,
        format!(
            "{}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0",
            auth.cookie_name()
        )
        .parse()
        .expect("cookie header"),
    );
}

pub(crate) async fn revoke(
    State(auth): State<Arc<ServerAuth>>,
    Extension(identity): Extension<RequestAuth>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Result<Response, StatusCode> {
    let cookie_id = auth
        .authenticate_cookie(&headers)
        .and_then(|identity| identity.id().map(str::to_owned));
    let (scope, target_id) = management_target(&auth, &id)?;
    let current = identity
        .id()
        .map(|id| auth_devices::get(&auth.scope(), id))
        .transpose()
        .map_err(storage_error)?
        .flatten();
    auth_devices::revoke_browser(&scope, &target_id).map_err(storage_error)?;
    auth.notify_revocation();
    let mut response = StatusCode::NO_CONTENT.into_response();
    if current
        .as_ref()
        .is_some_and(|device| device.browser_id() == target_id)
        && cookie_id.as_deref() == identity.id()
    {
        clear_cookie(&auth, &mut response);
    }
    Ok(response)
}

pub(crate) async fn logout(
    State(auth): State<Arc<ServerAuth>>,
    Extension(identity): Extension<RequestAuth>,
    headers: HeaderMap,
) -> Result<Response, StatusCode> {
    let cookie_id = auth
        .authenticate_cookie(&headers)
        .and_then(|identity| identity.id().map(str::to_owned));
    if let Some(id) = identity.id() {
        if let Some(device) = auth_devices::get(&auth.scope(), id).map_err(storage_error)? {
            auth_devices::revoke_browser(&auth.scope(), device.browser_id())
                .map_err(storage_error)?;
        }
    }
    auth.notify_revocation();
    let mut response = StatusCode::NO_CONTENT.into_response();
    if identity.id().is_none() || cookie_id.as_deref() == identity.id() {
        clear_cookie(&auth, &mut response);
    }
    Ok(response)
}

pub(crate) async fn no_store(request: axum::extract::Request, next: Next) -> Response {
    let mut response = next.run(request).await;
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, "no-store".parse().unwrap());
    response
}

pub(crate) async fn local_origin_guard(
    State(auth): State<Arc<ServerAuth>>,
    request: axum::extract::Request,
    next: Next,
) -> Response {
    if auth.secret_key.is_none() && !super::csrf::same_origin_browser_request(&request) {
        return (StatusCode::FORBIDDEN, "Cross-origin request blocked").into_response();
    }
    next.run(request).await
}

/// Drop the entire transport future on device revocation/expiry. ACP sessions
/// stay alive. Handlers spawning socket tasks use SocketTasks to abort those
/// tasks on cancellation instead of accidentally detaching them.
pub struct RevocableWebSocketUpgrade {
    inner: WebSocketUpgrade,
    device: Option<DeviceSession>,
}

impl<S: Send + Sync> FromRequestParts<S> for RevocableWebSocketUpgrade {
    type Rejection = axum::extract::ws::rejection::WebSocketUpgradeRejection;
    async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, Self::Rejection> {
        let device = parts
            .extensions
            .get::<RequestAuth>()
            .and_then(|identity| identity.device.clone());
        Ok(Self {
            inner: WebSocketUpgrade::from_request_parts(parts, state).await?,
            device,
        })
    }
}

impl RevocableWebSocketUpgrade {
    pub fn on_upgrade<C, F>(self, callback: C) -> Response
    where
        C: FnOnce(WebSocket) -> F + Send + 'static,
        F: Future<Output = ()> + Send + 'static,
    {
        self.inner.on_upgrade(move |socket| async move {
            if let Some(device) = self.device {
                tokio::select! { biased; _ = device.revoked() => {}, _ = callback(socket) => {} }
            } else {
                callback(socket).await;
            }
        })
    }
}

pub(crate) struct SocketTasks(pub Vec<tokio::task::AbortHandle>);
impl Drop for SocketTasks {
    fn drop(&mut self) {
        for task in &self.0 {
            task.abort();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    struct Sandbox {
        _dir: tempfile::TempDir,
    }
    impl Sandbox {
        fn new() -> Self {
            let dir = tempfile::tempdir().unwrap();
            crate::storage::set_grove_dir_override(Some(dir.path().to_path_buf()));
            Self { _dir: dir }
        }
    }
    impl Drop for Sandbox {
        fn drop(&mut self) {
            crate::storage::set_grove_dir_override(None);
        }
    }

    async fn authorize(auth: &Arc<ServerAuth>, trusted: bool) -> (String, HeaderMap) {
        authorize_with_headers(auth, trusted, HeaderMap::new()).await
    }

    async fn authorize_with_headers(
        auth: &Arc<ServerAuth>,
        trusted: bool,
        headers: HeaderMap,
    ) -> (String, HeaderMap) {
        let id = super::super::auth::generate_secret_key();
        let response = login(
            State(auth.clone()),
            Extension(RequestAuth::master()),
            Query(LoginQuery {
                device_id: id.clone(),
                previous_device_id: None,
                browser_id: None,
                trusted,
                cookie: None,
            }),
            headers,
            Json(LoginRequest {
                name: None,
                standalone: false,
            }),
        )
        .await
        .unwrap();
        let mut headers = HeaderMap::new();
        if trusted && auth.secure_cookies.load(Ordering::Relaxed) {
            let cookie = response.headers()[header::SET_COOKIE].to_str().unwrap();
            assert!(cookie.contains("HttpOnly; Secure; SameSite=Strict"));
            assert!(cookie.contains(&format!("Max-Age={}", COOKIE_MAX_AGE)));
            headers.insert(
                header::COOKIE,
                cookie.split(';').next().unwrap().parse().unwrap(),
            );
        }
        (id, headers)
    }

    fn signed_session(auth: &Arc<ServerAuth>, id: &str, nonce: &str) -> Option<RequestAuth> {
        let key = auth.keyed_value(&format!("grove-device-key-v1|{}", id));
        let ts = chrono::Utc::now().timestamp().to_string();
        let mut mac = HmacSha256::new_from_slice(key.as_bytes()).unwrap();
        mac.update(format!("{}|{}|GET|/api/v1/auth/session", ts, nonce).as_bytes());
        let signature = hex::encode(mac.finalize().into_bytes());
        auth.authenticate_signature(
            Some(id),
            RequestSignature::new(&ts, nonce, "GET", "/api/v1/auth/session", &signature),
        )
    }

    #[tokio::test]
    async fn native_banner_uses_the_device_and_stops_working_after_revocation() {
        let _lock = crate::storage::database::test_lock().lock().await;
        let _dir = Sandbox::new();
        let auth = Arc::new(ServerAuth::hmac("native-password".into(), false));
        let (id, _) = authorize(&auth, false).await;
        let credential = super::super::RemoteAuthorization {
            signing_key: auth.keyed_value(&format!("grove-device-key-v1|{}", id)),
            device_id: Some(id.clone()),
        };
        let request = || {
            super::super::sign_proxy_gui_action(
                reqwest::Client::new().post("http://localhost/api/v1/gui/permission"),
                "POST",
                "/api/v1/gui/permission",
                None,
                &credential,
            )
            .build()
            .unwrap()
        };
        let authenticate = |request: &reqwest::Request| {
            let headers = request.headers();
            auth.authenticate_signature(
                Some(headers["x-device-id"].to_str().unwrap()),
                RequestSignature::new(
                    headers["x-timestamp"].to_str().unwrap(),
                    headers["x-nonce"].to_str().unwrap(),
                    "POST",
                    "/api/v1/gui/permission",
                    headers["x-signature"].to_str().unwrap(),
                ),
            )
        };
        assert_eq!(authenticate(&request()).unwrap().id(), Some(id.as_str()));
        auth_devices::revoke(&auth.scope(), &id).unwrap();
        assert!(authenticate(&request()).is_none());
    }

    #[tokio::test]
    async fn password_changes_permanently_revoke_cookies_and_signed_sessions_even_when_reused() {
        let _lock = crate::storage::database::test_lock().lock().await;
        let _dir = Sandbox::new();
        let server = "127.0.0.1:3001".parse().unwrap();
        let first = Arc::new(ServerAuth::hmac("password-a".into(), false));
        first.initialize_device_auth(server).unwrap();
        first.secure_cookies.store(true, Ordering::Relaxed);
        let (cookie_id, cookie) = authorize(&first, true).await;
        let (tab_id, _) = authorize(&first, false).await;
        let first_scope = first.scope();
        let restarted = Arc::new(ServerAuth::hmac("password-a".into(), false));
        restarted.initialize_device_auth(server).unwrap();
        restarted.secure_cookies.store(true, Ordering::Relaxed);
        assert_eq!(restarted.scope(), first_scope);
        assert!(restarted.authenticate_cookie(&cookie).is_some());
        assert!(signed_session(&restarted, &tab_id, "same-password").is_some());

        let changed = Arc::new(ServerAuth::hmac("password-b".into(), false));
        changed.initialize_device_auth(server).unwrap();
        changed.secure_cookies.store(true, Ordering::Relaxed);
        assert!(auth_devices::get(&first_scope, &cookie_id)
            .unwrap()
            .is_none());
        assert!(first.authenticate_cookie(&cookie).is_none());
        assert!(signed_session(&first, &tab_id, "password-changed").is_none());
        let (second_id, second_cookie) = authorize(&changed, true).await;

        let reverted = Arc::new(ServerAuth::hmac("password-a".into(), false));
        reverted.initialize_device_auth(server).unwrap();
        reverted.secure_cookies.store(true, Ordering::Relaxed);
        assert_ne!(reverted.scope(), first_scope);
        assert!(reverted.authenticate_cookie(&cookie).is_none());
        assert!(signed_session(&reverted, &tab_id, "password-reused").is_none());
        assert!(changed.authenticate_cookie(&second_cookie).is_none());
        assert!(auth_devices::get(&changed.scope(), &second_id)
            .unwrap()
            .is_none());
        assert!(auth_devices::list_all().unwrap().is_empty());
        let (_, fresh_cookie) = authorize(&reverted, true).await;
        assert!(reverted.authenticate_cookie(&fresh_cookie).is_some());
    }

    #[tokio::test]
    async fn password_changes_do_not_revoke_an_independent_authentication_domain() {
        let _lock = crate::storage::database::test_lock().lock().await;
        let _dir = Sandbox::new();
        let first = Arc::new(ServerAuth::hmac("password-a".into(), false));
        first
            .initialize_device_auth("127.0.0.1:3001".parse().unwrap())
            .unwrap();
        let (first_id, _) = authorize(&first, true).await;
        let second = Arc::new(ServerAuth::hmac("password-b".into(), false));
        second
            .initialize_device_auth("127.0.0.1:3002".parse().unwrap())
            .unwrap();
        let (second_id, _) = authorize(&second, true).await;
        assert!(signed_session(&first, &first_id, "first-active").is_some());
        let changed = Arc::new(ServerAuth::hmac("new-password".into(), false));
        changed
            .initialize_device_auth("127.0.0.1:3001".parse().unwrap())
            .unwrap();
        assert!(signed_session(&first, &first_id, "first-revoked").is_none());
        assert!(signed_session(&second, &second_id, "second-preserved").is_some());
    }

    #[tokio::test]
    async fn same_host_instances_isolate_cookies_and_devices_even_with_the_same_password() {
        let _lock = crate::storage::database::test_lock().lock().await;
        let _dir = Sandbox::new();
        let first_address = "127.0.0.1:3001".parse().unwrap();
        let first = Arc::new(ServerAuth::hmac("password".into(), false));
        first.initialize_device_auth(first_address).unwrap();
        first.secure_cookies.store(true, Ordering::Relaxed);
        let (first_id, first_cookie) = authorize(&first, true).await;
        let (first_tab, _) = authorize(&first, false).await;

        let second = Arc::new(ServerAuth::hmac("password".into(), false));
        second
            .initialize_device_auth("127.0.0.1:3002".parse().unwrap())
            .unwrap();
        second.secure_cookies.store(true, Ordering::Relaxed);
        let (second_id, second_cookie) =
            authorize_with_headers(&second, true, first_cookie.clone()).await;
        let (second_tab, _) = authorize(&second, false).await;
        assert_ne!(first.scope(), second.scope());
        assert_ne!(first.cookie_name(), second.cookie_name());
        assert!(first.authenticate_cookie(&second_cookie).is_none());
        assert!(second.authenticate_cookie(&first_cookie).is_none());
        assert!(signed_session(&second, &first_tab, "wrong-instance").is_none());

        // Browsers send all same-host cookies, regardless of request port.
        let mut shared_cookies = HeaderMap::new();
        shared_cookies.insert(
            header::COOKIE,
            format!(
                "{}; {}",
                second_cookie[header::COOKIE].to_str().unwrap(),
                first_cookie[header::COOKIE].to_str().unwrap()
            )
            .parse()
            .unwrap(),
        );
        for (auth, id, port) in [(&first, &first_id, 3001), (&second, &second_id, 3002)] {
            assert_eq!(auth.cookie_device_id(&shared_cookies), Some(id.as_str()));
            let identity = auth.authenticate_cookie(&shared_cookies).unwrap();
            assert_eq!(identity.id(), Some(id.as_str()));
            let devices = list(State(auth.clone()), Extension(identity.clone()))
                .await
                .unwrap()
                .0;
            assert_eq!(devices["current_device_id"], *id);
            assert_eq!(devices["devices"].as_array().unwrap().len(), 2);
            assert!(devices["devices"]
                .as_array()
                .unwrap()
                .iter()
                .all(|device| device["port"] == port));
            let response = session(
                State(auth.clone()),
                Extension(identity),
                shared_cookies.clone(),
            )
            .await
            .unwrap();
            assert!(response.headers()[header::SET_COOKIE]
                .to_str()
                .unwrap()
                .starts_with(&format!("{}=", auth.cookie_name())));
        }

        revoke(
            State(first.clone()),
            Extension(first.identity(&first_id)),
            Path(first_tab.clone()),
            HeaderMap::new(),
        )
        .await
        .unwrap();
        assert!(signed_session(&first, &first_tab, "revoked-first-tab").is_none());
        assert!(signed_session(&second, &second_tab, "preserved-second-tab").is_some());
        assert!(second.authenticate_cookie(&shared_cookies).is_some());

        let response = logout(
            State(second.clone()),
            Extension(second.identity(&second_id)),
            shared_cookies.clone(),
        )
        .await
        .unwrap();
        assert!(response.headers()[header::SET_COOKIE]
            .to_str()
            .unwrap()
            .starts_with(&format!("{}=;", second.cookie_name())));
        assert!(second.authenticate_cookie(&shared_cookies).is_none());
        assert!(first.authenticate_cookie(&shared_cookies).is_some());

        let restarted = Arc::new(ServerAuth::hmac("password".into(), false));
        restarted.initialize_device_auth(first_address).unwrap();
        restarted.secure_cookies.store(true, Ordering::Relaxed);
        assert_eq!(restarted.cookie_name(), first.cookie_name());
        assert!(restarted.authenticate_cookie(&shared_cookies).is_some());
    }

    #[tokio::test]
    async fn legacy_global_mobile_authorizations_are_revoked_when_instances_are_separated() {
        let _lock = crate::storage::database::test_lock().lock().await;
        let _dir = Sandbox::new();
        let legacy = Arc::new(ServerAuth::hmac("password".into(), false));
        let legacy_scope = auth_devices::activate_server(
            "mobile",
            &legacy.keyed_value("grove-device-scope-v1"),
            &super::super::auth::generate_secret_key(),
        )
        .unwrap();
        legacy.device_scope.set(legacy_scope.clone()).unwrap();
        let (old_id, _) = authorize(&legacy, true).await;

        let current = Arc::new(ServerAuth::hmac("password".into(), false));
        current
            .initialize_device_auth("127.0.0.1:3001".parse().unwrap())
            .unwrap();
        assert!(auth_devices::get(&legacy_scope, &old_id).unwrap().is_none());
        assert!(signed_session(&legacy, &old_id, "legacy-global-revoked").is_none());
        let (current_id, _) = authorize(&current, true).await;

        let other = Arc::new(ServerAuth::hmac("another-password".into(), false));
        other
            .initialize_device_auth("127.0.0.1:3002".parse().unwrap())
            .unwrap();
        assert!(signed_session(&current, &current_id, "new-instance-preserved").is_some());
    }

    #[tokio::test]
    async fn legacy_password_scoped_authorizations_cannot_be_adopted_or_resurrected() {
        let _lock = crate::storage::database::test_lock().lock().await;
        let _dir = Sandbox::new();
        let first = Arc::new(ServerAuth::hmac("password-a".into(), false));
        let (first_id, _) = authorize(&first, true).await;
        let old = Arc::new(ServerAuth::hmac("old-password".into(), false));
        let (old_id, _) = authorize(&old, true).await;
        let current = Arc::new(ServerAuth::hmac("password-a".into(), false));
        current
            .initialize_device_auth("127.0.0.1:3001".parse().unwrap())
            .unwrap();
        assert!(signed_session(&current, &first_id, "not-adopted").is_none());
        assert!(auth_devices::get(&old.scope(), &old_id).unwrap().is_none());
        let (current_id, _) = authorize(&current, true).await;
        assert!(signed_session(&current, &current_id, "new-authorization").is_some());
        let changed = Arc::new(ServerAuth::hmac("old-password".into(), false));
        changed
            .initialize_device_auth("127.0.0.1:3001".parse().unwrap())
            .unwrap();
        assert!(signed_session(&changed, &old_id, "not-resurrected").is_none());
        assert!(signed_session(&current, &current_id, "now-revoked").is_none());
    }

    #[tokio::test]
    async fn trusted_cookie_retention_is_renewed_and_authorization_has_no_expiry() {
        let _lock = crate::storage::database::test_lock().lock().await;
        let _dir = Sandbox::new();
        let auth = Arc::new(ServerAuth::hmac("password".into(), false));
        auth.secure_cookies.store(true, Ordering::Relaxed);
        let (id, headers) = authorize(&auth, true).await;
        let response = session(State(auth.clone()), Extension(auth.identity(&id)), headers)
            .await
            .unwrap();
        assert!(response.headers()[header::SET_COOKIE]
            .to_str()
            .unwrap()
            .contains(&format!("Max-Age={}", COOKIE_MAX_AGE)));
        let body = axum::body::to_bytes(response.into_body(), 4096)
            .await
            .unwrap();
        let body: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert!(body["device"].get("expires_at").is_none());
        crate::storage::database::connection().execute(
            "UPDATE auth_devices SET created_at = 1, last_used_at = 1, expires_at = 1 WHERE id = ?1", [&id],
        ).unwrap();
        assert!(auth_devices::get(&auth.scope(), &id).unwrap().is_some());
    }

    #[tokio::test]
    async fn remembered_http_hmac_survives_restart_and_remains_revocable_and_password_scoped() {
        let _lock = crate::storage::database::test_lock().lock().await;
        let _dir = Sandbox::new();
        let auth = Arc::new(ServerAuth::hmac("password".into(), false));
        let info = super::super::auth::auth_info(State(auth.clone())).await.0;
        assert!(info.trusted_devices);
        assert!(!info.trusted_device_cookies);
        let (id, _) = authorize(&auth, true).await;
        let record = auth_devices::get(&auth.scope(), &id).unwrap().unwrap();
        assert!(record.trusted);
        assert!(record.token_hash.is_none());
        assert!(!serde_json::to_string(&record)
            .unwrap()
            .contains("expires_at"));
        assert!(signed_session(&auth, &id, "first").is_some());
        let restarted = Arc::new(ServerAuth::hmac("password".into(), false));
        assert!(signed_session(&restarted, &id, "second").is_some());
        let changed = Arc::new(ServerAuth::hmac("changed-password".into(), false));
        let key = auth.keyed_value(&format!("grove-device-key-v1|{}", id));
        let ts = chrono::Utc::now().timestamp().to_string();
        let mut mac = HmacSha256::new_from_slice(key.as_bytes()).unwrap();
        mac.update(format!("{}|third|GET|/api/v1/auth/session", ts).as_bytes());
        let signature = hex::encode(mac.finalize().into_bytes());
        assert!(changed
            .authenticate_signature(
                Some(&id),
                RequestSignature::new(&ts, "third", "GET", "/api/v1/auth/session", &signature)
            )
            .is_none());
        revoke(
            State(auth.clone()),
            Extension(auth.identity(&id)),
            Path(id.clone()),
            HeaderMap::new(),
        )
        .await
        .unwrap();
        assert!(signed_session(&restarted, &id, "fourth").is_none());
    }

    #[tokio::test]
    async fn remembering_a_signed_session_keeps_the_key_without_expiry() {
        let _lock = crate::storage::database::test_lock().lock().await;
        let _dir = Sandbox::new();
        let auth = Arc::new(ServerAuth::hmac("password".into(), false));
        let (id, _) = authorize(&auth, false).await;
        trust(
            State(auth.clone()),
            Extension(auth.identity(&id)),
            Query(TrustQuery {
                cookie: Some(false),
            }),
            HeaderMap::new(),
        )
        .await
        .unwrap();
        let record = auth_devices::get(&auth.scope(), &id).unwrap().unwrap();
        assert!(record.trusted);
        assert!(record.token_hash.is_none());
        assert!(signed_session(&auth, &id, "trusted").is_some());
        crate::storage::database::connection()
            .execute(
                "UPDATE auth_devices SET expires_at = 1 WHERE id = ?1",
                [&id],
            )
            .unwrap();
        assert!(signed_session(&auth, &id, "still-trusted").is_some());
    }

    #[tokio::test]
    async fn local_web_manages_mobile_devices_across_passwords_without_exposing_scopes() {
        let _lock = crate::storage::database::test_lock().lock().await;
        let _dir = Sandbox::new();
        let first = Arc::new(ServerAuth::hmac("first-password".into(), false));
        first
            .initialize_device_auth("127.0.0.1:3001".parse().unwrap())
            .unwrap();
        first.secure_cookies.store(true, Ordering::Relaxed);
        let (first_id, cookie) = authorize(&first, true).await;
        let second = Arc::new(ServerAuth::hmac("second-password".into(), false));
        second
            .initialize_device_auth("127.0.0.1:3002".parse().unwrap())
            .unwrap();
        let (second_id, _) = authorize(&second, false).await;
        // Even identical browser IDs in different password scopes must have
        // distinct local handles and must not revoke the wrong authorization.
        let mut duplicate = auth_devices::get(&second.scope(), &second_id)
            .unwrap()
            .unwrap();
        duplicate.id = first_id.clone();
        auth_devices::insert(&second.scope(), &duplicate, &[second_id]).unwrap();
        let local = Arc::new(ServerAuth::no_auth());
        let info = super::super::auth::auth_info(State(local.clone())).await.0;
        assert!(info.device_sessions);
        assert!(!info.required);
        let result = list(State(local.clone()), Extension(RequestAuth::master()))
            .await
            .unwrap()
            .0;
        let serialized = result.to_string();
        assert!(!serialized.contains(&first.scope()));
        assert!(!serialized.contains(&second.scope()));
        assert!(!serialized.contains(&first_id));
        assert!(!serialized.contains("token_hash"));
        assert_eq!(result["devices"].as_array().unwrap().len(), 2);
        assert!(result["current_device_id"].is_null());
        let handle = local.device_management_id(&first.scope(), &first_id);
        let second_handle = local.device_management_id(&second.scope(), &first_id);
        let listed = result["devices"].as_array().unwrap();
        assert_eq!(
            listed.iter().find(|device| device["id"] == handle).unwrap()["port"],
            3001
        );
        assert_eq!(
            listed
                .iter()
                .find(|device| device["id"] == second_handle)
                .unwrap()["port"],
            3002
        );
        assert!(!serialized.contains("127.0.0.1"));
        assert_ne!(
            handle,
            local.device_management_id(&second.scope(), &first_id)
        );
        rename(
            State(local.clone()),
            Path(handle.clone()),
            Json(RenameRequest {
                name: "My phone".into(),
            }),
        )
        .await
        .unwrap();
        assert_eq!(
            auth_devices::get(&first.scope(), &first_id)
                .unwrap()
                .unwrap()
                .name,
            "My phone"
        );
        assert_ne!(
            auth_devices::get(&second.scope(), &first_id)
                .unwrap()
                .unwrap()
                .name,
            "My phone"
        );
        let connection = first.authenticate_cookie(&cookie).unwrap().device.unwrap();
        revoke(
            State(local.clone()),
            Extension(RequestAuth::master()),
            Path(handle),
            HeaderMap::new(),
        )
        .await
        .unwrap();
        assert!(first.authenticate_cookie(&cookie).is_none());
        assert!(
            tokio::time::timeout(Duration::from_millis(100), connection.revoked())
                .await
                .is_ok()
        );
        assert!(auth_devices::get(&second.scope(), &first_id)
            .unwrap()
            .is_some());
        revoke(
            State(local.clone()),
            Extension(RequestAuth::master()),
            Path(local.device_management_id(&second.scope(), &first_id)),
            HeaderMap::new(),
        )
        .await
        .unwrap();
        assert!(auth_devices::list_all().unwrap().is_empty());

        let request = axum::http::Request::builder()
            .uri("/api/v1/auth/devices")
            .header("host", "localhost:3001")
            .header("origin", "http://localhost:3001")
            .body(axum::body::Body::empty())
            .unwrap();
        assert!(super::super::csrf::same_origin_browser_request(&request));
        assert!(!super::super::csrf::same_origin_request(&request));
        let request = axum::http::Request::builder()
            .uri("/api/v1/auth/devices")
            .header("host", "localhost:3001")
            .header("origin", "https://evil.test")
            .body(axum::body::Body::empty())
            .unwrap();
        assert!(!super::super::csrf::same_origin_browser_request(&request));
    }

    #[tokio::test]
    async fn remote_device_management_stays_in_its_password_scope() {
        let _lock = crate::storage::database::test_lock().lock().await;
        let _dir = Sandbox::new();
        let first = Arc::new(ServerAuth::hmac("first-password".into(), false));
        let second = Arc::new(ServerAuth::hmac("second-password".into(), false));
        let (first_id, _) = authorize(&first, false).await;
        let (second_id, _) = authorize(&second, false).await;
        let result = list(State(first.clone()), Extension(first.identity(&first_id)))
            .await
            .unwrap()
            .0;
        assert_eq!(result["devices"].as_array().unwrap().len(), 1);
        assert_eq!(result["devices"][0]["id"], first_id);
        assert_eq!(result["current_device_id"], first_id);
        assert_eq!(
            rename(
                State(first.clone()),
                Path(second_id.clone()),
                Json(RenameRequest {
                    name: "Wrong phone".into()
                })
            )
            .await
            .unwrap_err(),
            StatusCode::NOT_FOUND
        );
        revoke(
            State(first.clone()),
            Extension(first.identity(&first_id)),
            Path(second_id.clone()),
            HeaderMap::new(),
        )
        .await
        .unwrap();
        assert!(auth_devices::get(&second.scope(), &second_id)
            .unwrap()
            .is_some());
        revoke(
            State(first.clone()),
            Extension(first.identity(&first_id)),
            Path(first_id.clone()),
            HeaderMap::new(),
        )
        .await
        .unwrap();
        assert!(auth_devices::get(&second.scope(), &second_id)
            .unwrap()
            .is_some());
    }

    #[tokio::test]
    async fn trusted_cookie_survives_restart_and_is_scoped_to_password_and_tls() {
        let _lock = crate::storage::database::test_lock().lock().await;
        let _dir = Sandbox::new();
        let auth = Arc::new(ServerAuth::hmac("password".into(), false));
        auth.secure_cookies.store(true, Ordering::Relaxed);
        let (id, headers) = authorize(&auth, true).await;
        let assets = auth.plugin_device_asset_token("plugin-a", &id);
        assert!(auth.verify_plugin_asset_token("plugin-a", &assets));
        assert!(!auth.verify_plugin_asset_token("plugin-b", &assets));
        assert_eq!(
            auth.authenticate_cookie(&headers).unwrap().id(),
            Some(id.as_str())
        );
        let record = auth_devices::get(&auth.scope(), &id).unwrap().unwrap();
        let json = serde_json::to_string(&record).unwrap();
        assert!(!json.contains("token_hash"));
        assert!(!json.contains(record.token_hash.as_ref().unwrap()));
        assert!(!headers[header::COOKIE]
            .to_str()
            .unwrap()
            .contains(record.token_hash.as_ref().unwrap()));

        let restarted = Arc::new(ServerAuth::hmac("password".into(), false));
        assert!(restarted.authenticate_cookie(&headers).is_none());
        restarted.secure_cookies.store(true, Ordering::Relaxed);
        assert!(restarted.authenticate_cookie(&headers).is_some());
        let changed = Arc::new(ServerAuth::hmac("new-password".into(), false));
        changed.secure_cookies.store(true, Ordering::Relaxed);
        assert!(changed.authenticate_cookie(&headers).is_none());
        auth_devices::revoke(&auth.scope(), &id).unwrap();
        assert!(!auth.verify_plugin_asset_token("plugin-a", &assets));

        let request = axum::http::Request::builder()
            .uri("/ws")
            .header("host", "grove.test")
            .header("origin", "https://evil.test")
            .body(axum::body::Body::empty())
            .unwrap();
        assert!(!super::super::csrf::same_origin_request(&request));
        let request = axum::http::Request::builder()
            .uri("https://grove.test/ws")
            .header("origin", "https://grove.test")
            .body(axum::body::Body::empty())
            .unwrap();
        assert!(super::super::csrf::same_origin_request(&request));
    }

    #[tokio::test]
    async fn tab_hmac_is_revocable_and_cannot_fall_back_to_master_auth() {
        let _lock = crate::storage::database::test_lock().lock().await;
        let _dir = Sandbox::new();
        let auth = Arc::new(ServerAuth::hmac("password".into(), false));
        let (id, _) = authorize(&auth, false).await;
        let key = auth.keyed_value(&format!("grove-device-key-v1|{}", id));
        let ts = chrono::Utc::now().timestamp().to_string();
        let signature = |nonce: &str| {
            let mut mac = HmacSha256::new_from_slice(key.as_bytes()).unwrap();
            mac.update(format!("{}|{}|GET|/api/v1/auth/session", ts, nonce).as_bytes());
            hex::encode(mac.finalize().into_bytes())
        };
        assert!(auth
            .authenticate_signature(
                None,
                RequestSignature::new(
                    &ts,
                    "first",
                    "GET",
                    "/api/v1/auth/session",
                    &signature("first")
                )
            )
            .is_none());
        assert!(auth
            .authenticate_signature(
                Some(&id),
                RequestSignature::new(
                    &ts,
                    "first",
                    "GET",
                    "/api/v1/auth/session",
                    &signature("first")
                )
            )
            .is_some());
        assert!(auth
            .authenticate_signature(
                Some(&id),
                RequestSignature::new(
                    &ts,
                    "first",
                    "GET",
                    "/api/v1/auth/session",
                    &signature("first")
                )
            )
            .is_none());
        assert!(auth_devices::get(&auth.scope(), &id)
            .unwrap()
            .unwrap()
            .token_hash
            .is_none());
        auth_devices::revoke(&auth.scope(), &id).unwrap();
        assert!(auth
            .authenticate_signature(
                Some(&id),
                RequestSignature::new(
                    &ts,
                    "second",
                    "GET",
                    "/api/v1/auth/session",
                    &signature("second")
                )
            )
            .is_none());
    }

    #[tokio::test]
    async fn one_browser_is_listed_once_per_port_and_revocation_covers_its_tabs() {
        let _lock = crate::storage::database::test_lock().lock().await;
        let _dir = Sandbox::new();
        let first = Arc::new(ServerAuth::hmac("password".into(), false));
        let second = Arc::new(ServerAuth::hmac("password".into(), false));
        first
            .initialize_device_auth("0.0.0.0:3001".parse().unwrap())
            .unwrap();
        second
            .initialize_device_auth("0.0.0.0:3002".parse().unwrap())
            .unwrap();
        let browser = super::super::auth::generate_secret_key();
        let mut ids = Vec::new();
        for (auth, trusted) in [(&first, false), (&first, true), (&second, false)] {
            let id = super::super::auth::generate_secret_key();
            login(
                State(auth.clone()),
                Extension(RequestAuth::master()),
                Query(LoginQuery {
                    device_id: id.clone(),
                    previous_device_id: None,
                    browser_id: Some(browser.clone()),
                    trusted,
                    cookie: Some(false),
                }),
                HeaderMap::new(),
                Json(LoginRequest {
                    name: None,
                    standalone: false,
                }),
            )
            .await
            .unwrap();
            ids.push(id);
        }
        let (old_tab, _) = authorize(&first, false).await;
        bound_session(
            State(first.clone()),
            Extension(first.identity(&old_tab)),
            Query(SessionQuery {
                browser_id: Some(browser.clone()),
            }),
            HeaderMap::new(),
        )
        .await
        .unwrap();
        let devices = list(State(first.clone()), Extension(first.identity(&ids[0])))
            .await
            .unwrap()
            .0;
        assert_eq!(devices["devices"].as_array().unwrap().len(), 1);
        assert_eq!(devices["devices"][0]["id"], browser);
        assert_eq!(devices["devices"][0]["trusted"], true);
        assert_eq!(devices["current_device_id"], browser);
        assert!(signed_session(&first, &ids[0], "first-tab-still-active").is_some());
        assert!(signed_session(&first, &ids[1], "second-tab-still-active").is_some());
        rename(
            State(first.clone()),
            Path(browser.clone()),
            Json(RenameRequest {
                name: "My phone".into(),
            }),
        )
        .await
        .unwrap();
        assert!(auth_devices::list(&first.scope())
            .unwrap()
            .iter()
            .all(|device| device.name == "My phone"));
        let local = Arc::new(ServerAuth::no_auth());
        let all = list(State(local.clone()), Extension(RequestAuth::master()))
            .await
            .unwrap()
            .0;
        assert_eq!(all["devices"].as_array().unwrap().len(), 2);
        let handle = all["devices"]
            .as_array()
            .unwrap()
            .iter()
            .find(|device| device["port"] == 3001)
            .unwrap()["id"]
            .as_str()
            .unwrap();
        revoke(
            State(local),
            Extension(RequestAuth::master()),
            Path(handle.to_owned()),
            HeaderMap::new(),
        )
        .await
        .unwrap();
        assert!(signed_session(&first, &ids[0], "first-tab-revoked").is_none());
        assert!(signed_session(&first, &ids[1], "second-tab-revoked").is_none());
        assert!(signed_session(&first, &old_tab, "old-tab-revoked").is_none());
        assert!(signed_session(&second, &ids[2], "other-port-preserved").is_some());
    }

    #[tokio::test]
    async fn storage_change_notifications_revoke_waiting_connections_without_a_timer() {
        let _lock = crate::storage::database::test_lock().lock().await;
        let _dir = Sandbox::new();
        let auth = Arc::new(ServerAuth::hmac("password".into(), false));
        let (id, _) = authorize(&auth, false).await;
        let connection = auth.identity(&id).device.unwrap();
        // Storage revocation emits no ServerAuth signal, like an API running
        // in a different Grove process that shares the authorization database.
        let (closed, _) = tokio::join!(
            tokio::time::timeout(Duration::from_secs(3), connection.revoked()),
            async {
                tokio::time::sleep(Duration::from_millis(20)).await;
                auth_devices::revoke_browser(&auth.scope(), &id).unwrap();
            }
        );
        assert!(closed.is_ok());
    }

    #[tokio::test]
    async fn auth_cache_policy_and_revocation_errors_do_not_change_other_api_responses() {
        use tower::ServiceExt;
        let _lock = crate::storage::database::test_lock().lock().await;
        let _dir = Sandbox::new();
        let local = Arc::new(ServerAuth::no_auth());
        let router = super::super::create_router(None, local, None);
        for (path, no_store) in [
            ("/api/v1/auth/info", true),
            ("/api/v1/auth/devices", true),
            ("/api/v1/version", false),
        ] {
            let response = router
                .clone()
                .oneshot(
                    axum::http::Request::builder()
                        .uri(path)
                        .header("host", "localhost:3001")
                        .body(axum::body::Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK);
            assert_eq!(
                response
                    .headers()
                    .get(header::CACHE_CONTROL)
                    .is_some_and(|value| value == "no-store"),
                no_store
            );
        }
        let auth = Arc::new(ServerAuth::hmac("password".into(), false));
        let (id, _) = authorize(&auth, false).await;
        auth_devices::revoke(&auth.scope(), &id).unwrap();
        let response = super::super::create_router(None, auth, None)
            .oneshot(
                axum::http::Request::builder()
                    .uri("/api/v1/auth/session")
                    .header("X-Device-Id", &id)
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(response.headers()["x-grove-auth-error"], "AUTH_REVOKED");
        let json: serde_json::Value = serde_json::from_slice(
            &axum::body::to_bytes(response.into_body(), usize::MAX)
                .await
                .unwrap(),
        )
        .unwrap();
        assert_eq!(json["code"], "AUTH_REVOKED");
    }

    #[tokio::test]
    async fn revoking_one_device_preserves_current_device_and_notifies_live_connections() {
        let _lock = crate::storage::database::test_lock().lock().await;
        let _dir = Sandbox::new();
        let auth = Arc::new(ServerAuth::hmac("password".into(), false));
        auth.secure_cookies.store(true, Ordering::Relaxed);
        let (current, current_cookie) = authorize(&auth, true).await;
        let (other, other_cookie) = authorize(&auth, true).await;
        let identity = auth.authenticate_cookie(&current_cookie).unwrap();
        let connection = auth
            .authenticate_cookie(&other_cookie)
            .unwrap()
            .device
            .unwrap();
        let (closed, _) = tokio::join!(
            tokio::time::timeout(Duration::from_millis(300), connection.revoked()),
            async {
                tokio::time::sleep(Duration::from_millis(5)).await;
                revoke(
                    State(auth.clone()),
                    Extension(identity),
                    Path(other.clone()),
                    HeaderMap::new(),
                )
                .await
                .unwrap();
            }
        );
        assert!(closed.is_ok());
        assert!(auth.authenticate_cookie(&current_cookie).is_some());
        assert!(auth.authenticate_cookie(&other_cookie).is_none());
        assert!(auth_devices::get(&auth.scope(), &other).unwrap().is_none());
        let response = logout(
            State(auth.clone()),
            Extension(auth.identity(&current)),
            current_cookie.clone(),
        )
        .await
        .unwrap();
        assert!(response.headers()[header::SET_COOKIE]
            .to_str()
            .unwrap()
            .contains("Max-Age=0"));
        assert!(auth.authenticate_cookie(&current_cookie).is_none());
    }

    #[tokio::test]
    async fn actual_requests_update_last_used_and_renamed_sessions_have_no_expiry() {
        let _lock = crate::storage::database::test_lock().lock().await;
        let _dir = Sandbox::new();
        let auth = Arc::new(ServerAuth::hmac("password".into(), false));
        let (id, _) = authorize(&auth, false).await;
        let scope = auth.scope();
        crate::storage::database::connection()
            .execute(
                "UPDATE auth_devices SET last_used_at = last_used_at - 600 WHERE id = ?1",
                [&id],
            )
            .unwrap();
        let old = auth_devices::get(&scope, &id)
            .unwrap()
            .unwrap()
            .last_used_at;
        let _ = session(
            State(auth.clone()),
            Extension(auth.identity(&id)),
            HeaderMap::new(),
        )
        .await
        .unwrap();
        assert_eq!(
            auth_devices::get(&scope, &id)
                .unwrap()
                .unwrap()
                .last_used_at,
            old
        );
        use tower::ServiceExt;
        let path = "/api/v1/auth/session";
        let timestamp = chrono::Utc::now().timestamp().to_string();
        let nonce = "last-used-request";
        let key = auth.keyed_value(&format!("grove-device-key-v1|{}", id));
        let mut mac = HmacSha256::new_from_slice(key.as_bytes()).unwrap();
        mac.update(format!("{timestamp}|{nonce}|GET|{path}").as_bytes());
        let response = super::super::create_router(None, auth.clone(), None)
            .oneshot(
                axum::http::Request::builder()
                    .uri(path)
                    .header("X-Device-Id", &id)
                    .header("X-Timestamp", &timestamp)
                    .header("X-Nonce", nonce)
                    .header("X-Signature", hex::encode(mac.finalize().into_bytes()))
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert!(
            auth_devices::get(&scope, &id)
                .unwrap()
                .unwrap()
                .last_used_at
                > old
        );
        assert_eq!(
            rename(
                State(auth.clone()),
                Path(id.clone()),
                Json(RenameRequest { name: "\n".into() })
            )
            .await
            .unwrap_err(),
            StatusCode::BAD_REQUEST
        );
        rename(
            State(auth.clone()),
            Path(id.clone()),
            Json(RenameRequest {
                name: "My iPhone 18".into(),
            }),
        )
        .await
        .unwrap();
        assert_eq!(
            auth_devices::get(&scope, &id).unwrap().unwrap().name,
            "My iPhone 18"
        );
        crate::storage::database::connection()
            .execute(
                "UPDATE auth_devices SET expires_at = 1 WHERE id = ?1",
                [&id],
            )
            .unwrap();
        assert!(auth_devices::get(&scope, &id).unwrap().is_some());
        assert_eq!(auth_devices::list(&scope).unwrap().len(), 1);
        let result = login(
            State(auth),
            Extension(RequestAuth::master()),
            Query(LoginQuery {
                device_id: super::super::auth::generate_secret_key(),
                previous_device_id: None,
                browser_id: None,
                trusted: true,
                cookie: Some(true),
            }),
            HeaderMap::new(),
            Json(LoginRequest {
                name: None,
                standalone: false,
            }),
        )
        .await;
        assert_eq!(result.unwrap_err(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn trusting_a_tab_rotates_its_authorization_and_logout_keeps_unrelated_cookies() {
        let _lock = crate::storage::database::test_lock().lock().await;
        let _dir = Sandbox::new();
        let auth = Arc::new(ServerAuth::hmac("password".into(), false));
        auth.secure_cookies.store(true, Ordering::Relaxed);
        let (tab, _) = authorize(&auth, false).await;
        let response = trust(
            State(auth.clone()),
            Extension(auth.identity(&tab)),
            Query(TrustQuery { cookie: Some(true) }),
            HeaderMap::new(),
        )
        .await
        .unwrap();
        let cookie = response.headers()[header::SET_COOKIE]
            .to_str()
            .unwrap()
            .split(';')
            .next()
            .unwrap();
        let mut headers = HeaderMap::new();
        headers.insert(header::COOKIE, cookie.parse().unwrap());
        let trusted = auth
            .authenticate_cookie(&headers)
            .unwrap()
            .id()
            .unwrap()
            .to_owned();
        assert_ne!(tab, trusted);
        assert!(auth_devices::get(&auth.scope(), &tab).unwrap().is_none());
        let (other_tab, _) = authorize(&auth, false).await;
        let response = logout(
            State(auth.clone()),
            Extension(auth.identity(&other_tab)),
            headers.clone(),
        )
        .await
        .unwrap();
        assert!(!response.headers().contains_key(header::SET_COOKIE));
        assert!(auth.authenticate_cookie(&headers).is_some());
        assert!(auth_devices::get(&auth.scope(), &other_tab)
            .unwrap()
            .is_none());
    }
}

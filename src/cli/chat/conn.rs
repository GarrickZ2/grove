//! Connection to a Grove server: discovery, headless auto-start, and the same
//! device sign-in the Mobile web client uses (passkey once → device key).

use std::path::PathBuf;
use std::time::Duration;

use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha2::Sha256;

type HmacSha256 = Hmac<Sha256>;

/// A device credential minted by `/api/v1/auth/login`. The passkey itself is
/// never stored — only the revocable per-device signing key derived from it.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeviceCredential {
    pub url: String,
    pub device_id: String,
    pub device_key: String,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct RemotesFile {
    #[serde(default, rename = "remote")]
    remotes: Vec<DeviceCredential>,
}

fn remotes_path() -> PathBuf {
    crate::storage::grove_dir().join("remotes.toml")
}

/// The remote this machine signed in to last (`grove cli --remote`).
pub fn last_remote() -> Option<String> {
    let raw = std::fs::read_to_string(remotes_path()).ok()?;
    let file: RemotesFile = toml::from_str(&raw).ok()?;
    file.remotes.last().map(|remote| remote.url.clone())
}

fn load_credential(url: &str) -> Option<DeviceCredential> {
    let raw = std::fs::read_to_string(remotes_path()).ok()?;
    let file: RemotesFile = toml::from_str(&raw).ok()?;
    file.remotes.into_iter().find(|remote| remote.url == url)
}

fn save_credential(credential: &DeviceCredential) -> std::io::Result<()> {
    let path = remotes_path();
    let mut file: RemotesFile = std::fs::read_to_string(&path)
        .ok()
        .and_then(|raw| toml::from_str(&raw).ok())
        .unwrap_or_default();
    file.remotes.retain(|remote| remote.url != credential.url);
    file.remotes.push(credential.clone());
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let body = toml::to_string_pretty(&file).map_err(std::io::Error::other)?;
    std::fs::write(&path, body)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))?;
    }
    Ok(())
}

fn forget_credential(url: &str) {
    let path = remotes_path();
    let Some(mut file) = std::fs::read_to_string(&path)
        .ok()
        .and_then(|raw| toml::from_str::<RemotesFile>(&raw).ok())
    else {
        return;
    };
    file.remotes.retain(|remote| remote.url != url);
    if let Ok(body) = toml::to_string_pretty(&file) {
        let _ = std::fs::write(&path, body);
    }
}

pub(crate) fn hmac_hex(key: &str, message: &str) -> String {
    let mut mac = HmacSha256::new_from_slice(key.as_bytes()).expect("HMAC accepts any key length");
    mac.update(message.as_bytes());
    hex::encode(mac.finalize().into_bytes())
}

fn random_hex() -> String {
    crate::api::auth::generate_secret_key()
}

/// Canonical form the server signs over: path plus `&`-joined query pairs
/// sorted by `(key, value)`. Mirrors `api::auth::canonical_path`.
fn canonical(path_and_query: &str) -> String {
    match path_and_query.split_once('?') {
        Some((path, query)) => crate::api::auth::canonical_path(path, Some(query), &[]),
        None => path_and_query.to_string(),
    }
}

/// Signing headers for one request. The server rejects reused nonces and
/// timestamps outside ±60 s, so these are minted per request.
pub(crate) fn signed_headers(
    key: &str,
    device_id: Option<&str>,
    method: &str,
    path: &str,
) -> Vec<(String, String)> {
    let timestamp = chrono::Utc::now().timestamp().to_string();
    let nonce = random_hex();
    let signature = hmac_hex(
        key,
        &format!("{timestamp}|{nonce}|{method}|{}", canonical(path)),
    );
    let mut headers = vec![
        ("X-Timestamp".to_string(), timestamp),
        ("X-Nonce".to_string(), nonce),
        ("X-Signature".to_string(), signature),
    ];
    if let Some(id) = device_id {
        headers.push(("X-Device-Id".to_string(), id.to_string()));
    }
    headers
}

#[derive(Debug, thiserror::Error)]
pub enum ConnError {
    #[error("{0}")]
    Http(String),
    #[error("Grove server answered {status}: {message}")]
    Status { status: u16, message: String },
    #[error("unauthorized")]
    Unauthorized,
    #[error("{0}")]
    Other(String),
}

impl From<reqwest::Error> for ConnError {
    fn from(error: reqwest::Error) -> Self {
        if error.is_connect() || error.is_timeout() {
            let server = error
                .url()
                .map(|url| url.origin().ascii_serialization())
                .unwrap_or_default();
            return ConnError::Http(format!("cannot reach the Grove server {server}"));
        }
        ConnError::Http(error.to_string())
    }
}

pub type Result<T> = std::result::Result<T, ConnError>;

/// An authenticated handle on one Grove server.
#[derive(Clone)]
pub struct Conn {
    pub base_url: String,
    pub remote: bool,
    http: reqwest::Client,
    credential: Option<DeviceCredential>,
}

impl Conn {
    fn new(base_url: String, remote: bool) -> Self {
        let http = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(5))
            .build()
            .expect("reqwest client");
        let credential = load_credential(&base_url);
        Self {
            base_url,
            remote,
            http,
            credential,
        }
    }

    /// Short label for the status bar: `local` or the remote host.
    pub fn label(&self) -> String {
        if !self.remote {
            return "local".to_string();
        }
        self.base_url
            .split("://")
            .nth(1)
            .unwrap_or(&self.base_url)
            .trim_end_matches('/')
            .to_string()
    }

    fn auth_headers(&self, method: &str, path: &str) -> Vec<(String, String)> {
        match &self.credential {
            Some(credential) => signed_headers(
                &credential.device_key,
                Some(&credential.device_id),
                method,
                path,
            ),
            None => Vec::new(),
        }
    }

    async fn send(
        &self,
        method: reqwest::Method,
        path: &str,
        body: Option<&serde_json::Value>,
    ) -> Result<reqwest::Response> {
        let mut request = self
            .http
            .request(method.clone(), format!("{}{}", self.base_url, path))
            .timeout(Duration::from_secs(30));
        for (name, value) in self.auth_headers(method.as_str(), path) {
            request = request.header(name, value);
        }
        if let Some(body) = body {
            request = request.json(body);
        }
        let response = request.send().await?;
        if response.status() == reqwest::StatusCode::UNAUTHORIZED {
            return Err(ConnError::Unauthorized);
        }
        if !response.status().is_success() {
            let status = response.status().as_u16();
            let text = response.text().await.unwrap_or_default();
            let message = serde_json::from_str::<serde_json::Value>(&text)
                .ok()
                .and_then(|value| {
                    value
                        .get("message")
                        .or_else(|| value.get("error"))
                        .and_then(|m| m.as_str())
                        .map(str::to_owned)
                })
                .unwrap_or(text);
            return Err(ConnError::Status { status, message });
        }
        Ok(response)
    }

    pub async fn get<T: serde::de::DeserializeOwned>(&self, path: &str) -> Result<T> {
        Ok(self
            .send(reqwest::Method::GET, path, None)
            .await?
            .json()
            .await?)
    }

    pub async fn post<T: serde::de::DeserializeOwned>(
        &self,
        path: &str,
        body: &serde_json::Value,
    ) -> Result<T> {
        Ok(self
            .send(reqwest::Method::POST, path, Some(body))
            .await?
            .json()
            .await?)
    }

    /// A request whose response body the caller does not need.
    pub async fn call(
        &self,
        method: reqwest::Method,
        path: &str,
        body: &serde_json::Value,
    ) -> Result<()> {
        self.send(method, path, Some(body)).await.map(|_| ())
    }

    /// Open a chat WebSocket. Signs the upgrade with headers, which the
    /// server accepts the same way as for plain requests.
    pub async fn websocket(
        &self,
        path: &str,
    ) -> Result<
        tokio_tungstenite::WebSocketStream<
            tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
        >,
    > {
        use tokio_tungstenite::tungstenite::client::IntoClientRequest;
        let ws_base = if let Some(rest) = self.base_url.strip_prefix("https://") {
            format!("wss://{rest}")
        } else if let Some(rest) = self.base_url.strip_prefix("http://") {
            format!("ws://{rest}")
        } else {
            self.base_url.clone()
        };
        let mut request = format!("{ws_base}{path}")
            .into_client_request()
            .map_err(|e| ConnError::Other(e.to_string()))?;
        for (name, value) in self.auth_headers("GET", path) {
            let name =
                tokio_tungstenite::tungstenite::http::HeaderName::from_bytes(name.as_bytes())
                    .map_err(|e| ConnError::Other(e.to_string()))?;
            let value = value
                .parse()
                .map_err(|_| ConnError::Other("invalid header".into()))?;
            request.headers_mut().insert(name, value);
        }
        match tokio_tungstenite::connect_async(request).await {
            Ok((stream, _)) => Ok(stream),
            Err(tokio_tungstenite::tungstenite::Error::Http(response))
                if response.status().as_u16() == 401 =>
            {
                Err(ConnError::Unauthorized)
            }
            Err(error) => Err(ConnError::Http(error.to_string())),
        }
    }

    /// Whether the server wants signed requests at all.
    async fn auth_required(&self) -> Result<bool> {
        #[derive(Deserialize)]
        struct Info {
            required: bool,
        }
        let info: Info = self
            .http
            .get(format!("{}/api/v1/auth/info", self.base_url))
            .timeout(Duration::from_secs(5))
            .send()
            .await?
            .json()
            .await?;
        Ok(info.required)
    }

    /// Sign this device in with the server's passkey, exactly like Mobile:
    /// the passkey signs one login request and derives the device key; only
    /// the device key is kept.
    async fn login(&mut self, passkey: &str) -> Result<()> {
        let device_id = random_hex();
        let path = format!("/api/v1/auth/login?device_id={device_id}&trusted=true&cookie=false");
        let mut request = self
            .http
            .post(format!("{}{}", self.base_url, path))
            .timeout(Duration::from_secs(10))
            .json(&serde_json::json!({ "name": device_name() }));
        for (name, value) in signed_headers(passkey, None, "POST", &path) {
            request = request.header(name, value);
        }
        let response = request.send().await?;
        if response.status() == reqwest::StatusCode::UNAUTHORIZED {
            return Err(ConnError::Other("Passkey rejected".into()));
        }
        if !response.status().is_success() {
            return Err(ConnError::Status {
                status: response.status().as_u16(),
                message: response.text().await.unwrap_or_default(),
            });
        }
        let credential = DeviceCredential {
            url: self.base_url.clone(),
            device_key: hmac_hex(passkey, &format!("grove-device-key-v1|{device_id}")),
            device_id,
        };
        save_credential(&credential).map_err(|e| ConnError::Other(e.to_string()))?;
        self.credential = Some(credential);
        Ok(())
    }

    /// Prompt for the passkey until the server accepts it (or the user gives up).
    pub async fn ensure_authorized(&mut self) -> Result<()> {
        if !self.auth_required().await? {
            return Ok(());
        }
        if self.credential.is_some() {
            match self
                .send(reqwest::Method::GET, "/api/v1/auth/session", None)
                .await
            {
                Ok(_) => return Ok(()),
                Err(ConnError::Unauthorized) => {
                    forget_credential(&self.base_url);
                    self.credential = None;
                    eprintln!("This device was signed out of {}.", self.label());
                }
                Err(error) => return Err(error),
            }
        }
        for _ in 0..3 {
            let passkey = rpassword::prompt_password(format!("Passkey for {}: ", self.label()))
                .map_err(|e| ConnError::Other(e.to_string()))?;
            let passkey = passkey.trim();
            if passkey.is_empty() {
                break;
            }
            match self.login(passkey).await {
                Ok(()) => {
                    eprintln!("Signed in. This device now appears in the server's device list.");
                    return Ok(());
                }
                Err(error) => eprintln!("{error}"),
            }
        }
        Err(ConnError::Other("Not signed in".into()))
    }
}

pub(crate) fn device_name() -> String {
    let host = std::env::var("HOSTNAME")
        .ok()
        .or_else(|| {
            std::process::Command::new("hostname")
                .output()
                .ok()
                .and_then(|out| String::from_utf8(out.stdout).ok())
        })
        .map(|name| name.trim().to_string())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| "terminal".into());
    format!("grove cli · {host}")
}

async fn is_alive(http: &reqwest::Client, base_url: &str) -> bool {
    match http
        .get(format!("{base_url}/api/v1/version"))
        .timeout(Duration::from_millis(800))
        .send()
        .await
    {
        // A server in passkey mode still answers, just with 401.
        Ok(response) => response.status().is_success() || response.status().as_u16() == 401,
        Err(_) => false,
    }
}

fn recorded_endpoint() -> Option<String> {
    std::fs::read_to_string(crate::storage::grove_dir().join("gui_endpoint"))
        .ok()
        .map(|raw| raw.trim().trim_end_matches('/').to_string())
        .filter(|raw| !raw.is_empty())
}

/// Start a headless server (`grove serve`) in its own process group so it
/// outlives this CLI, logging to `~/.grove/server.log`.
fn spawn_headless_server() -> std::io::Result<()> {
    let exe = std::env::current_exe()?;
    let log_path = crate::storage::grove_dir().join("server.log");
    let log = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)?;
    let mut command = std::process::Command::new(exe);
    command
        .arg("serve")
        .stdin(std::process::Stdio::null())
        .stdout(log.try_clone()?)
        .stderr(log);
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    command.spawn()?;
    Ok(())
}

/// Find the local Grove server, starting a headless one when none is running.
pub async fn connect_local() -> Result<Conn> {
    connect_local_with(true, true).await
}

/// [`connect_local`] for reconnecting: silent (the inline UI owns the
/// terminal), and starting a server only when `spawn` is set.
pub async fn connect_local_with(announce: bool, spawn: bool) -> Result<Conn> {
    let probe = reqwest::Client::new();
    let mut candidates: Vec<String> = recorded_endpoint().into_iter().collect();
    let default = format!("http://127.0.0.1:{}", crate::cli::web::DEFAULT_PORT);
    if !candidates.contains(&default) {
        candidates.push(default.clone());
    }
    for candidate in &candidates {
        if is_alive(&probe, candidate).await {
            return Ok(Conn::new(candidate.clone(), false));
        }
    }

    if !spawn {
        return Err(ConnError::Other("no Grove server is running".into()));
    }
    if announce {
        eprintln!("Starting Grove server in the background…");
    }
    spawn_headless_server().map_err(|e| ConnError::Other(format!("start server: {e}")))?;
    let deadline = std::time::Instant::now() + Duration::from_secs(20);
    while std::time::Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(300)).await;
        // The server rewrites the endpoint file once bound (it may fall back
        // from the default port), so re-read it on every poll.
        let mut urls: Vec<String> = recorded_endpoint().into_iter().collect();
        urls.push(default.clone());
        for url in urls {
            if is_alive(&probe, &url).await {
                return Ok(Conn::new(url, false));
            }
        }
    }
    Err(ConnError::Other(format!(
        "Grove server did not start; see {}",
        crate::storage::grove_dir().join("server.log").display()
    )))
}

/// Connect to a remote Grove server (`grove mobile` on another machine).
pub async fn connect_remote(url: &str) -> Result<Conn> {
    let mut url = url.trim().trim_end_matches('/').to_string();
    if !url.contains("://") {
        url = format!("http://{url}");
    }
    let probe = reqwest::Client::new();
    if !is_alive(&probe, &url).await {
        return Err(ConnError::Other(format!("Cannot reach Grove at {url}")));
    }
    Ok(Conn::new(url, true))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn signature_matches_server_verification() {
        let auth = crate::api::auth::ServerAuth::hmac("passkey".into(), false);
        let path = "/api/v1/projects/p/tasks?b=2&a=1";
        let headers = signed_headers("passkey", None, "GET", path);
        let get = |name: &str| {
            headers
                .iter()
                .find(|(key, _)| key == name)
                .map(|(_, value)| value.clone())
                .unwrap()
        };
        let canonical =
            crate::api::auth::canonical_path("/api/v1/projects/p/tasks", Some("b=2&a=1"), &[]);
        assert!(auth.verify_signature(
            &get("X-Timestamp"),
            &get("X-Nonce"),
            "GET",
            &canonical,
            &get("X-Signature"),
        ));
    }
}

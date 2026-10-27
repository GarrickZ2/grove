//! Grove owns remote MCP discovery and OAuth. Agents receive a credential
//! snapshot through ACP; they connect to the remote server directly.

use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Arc, OnceLock},
    time::Duration,
};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use reqwest::{header::HeaderMap, Client, StatusCode};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio::sync::Mutex;
use url::Url;

type Result<T> = std::result::Result<T, String>;
const FLOW_SECONDS: u64 = 600;
const MAX_BODY: usize = 2 * 1024 * 1024;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ServerInfo {
    pub name: String,
    pub title: Option<String>,
    pub version: Option<String>,
    pub description: Option<String>,
    pub website_url: Option<String>,
    #[serde(default)]
    pub icons: Vec<Value>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ConnectionSummary {
    pub url: String,
    pub status: String,
    pub auth_type: String,
    pub has_credentials: bool,
    pub server_info: Option<ServerInfo>,
    pub checked_at: Option<u64>,
    pub expires_at: Option<u64>,
    pub scopes: Vec<String>,
    pub error: Option<String>,
}

// Never return this record through an API or place it in a server.json.
#[derive(Clone, Default, Serialize, Deserialize)]
struct Connection {
    url: String,
    #[serde(default)]
    generation: String,
    info: Option<ServerInfo>,
    checked_at: Option<u64>,
    error: Option<String>,
    #[serde(default)]
    auth_required: bool,
    oauth: Option<OAuthMetadata>,
    client_id: Option<String>,
    client_secret: Option<String>,
    token: Option<Token>,
}

#[derive(Clone, Serialize, Deserialize)]
struct OAuthMetadata {
    issuer: String,
    resource: String,
    authorization_endpoint: String,
    token_endpoint: String,
    registration_endpoint: Option<String>,
    revocation_endpoint: Option<String>,
    #[serde(default)]
    scopes: Vec<String>,
    #[serde(default)]
    auth_methods: Vec<String>,
    #[serde(default)]
    response_iss_required: bool,
    #[serde(default)]
    cimd_supported: bool,
}

#[derive(Clone, Serialize, Deserialize)]
struct Token {
    access_token: String,
    refresh_token: Option<String>,
    expires_at: Option<u64>,
    scopes: Vec<String>,
}

struct Flow {
    url: String,
    path: PathBuf,
    generation: String,
    state: String,
    verifier: String,
    redirect_uri: String,
    oauth: OAuthMetadata,
    client_id: String,
    client_secret: Option<String>,
    created_at: u64,
    status: String,
    error: Option<String>,
    stop: Option<tokio::sync::oneshot::Sender<()>>,
}

#[derive(Serialize)]
pub struct FlowSummary {
    pub id: String,
    pub status: String,
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub authorization_url: Option<String>,
}

mod package;
pub use package::{
    cancel_package_probe, package_probe_status, start_package_probe, PackageProbeSummary,
};
#[cfg(test)]
use package::{package_handshake, package_response, probe_package_process};

fn server_info(value: &Value) -> Option<ServerInfo> {
    Some(ServerInfo {
        name: value["name"].as_str()?.into(),
        title: value["title"].as_str().map(str::to_string),
        version: value["version"].as_str().map(str::to_string),
        description: value["description"].as_str().map(str::to_string),
        website_url: value["websiteUrl"].as_str().map(str::to_string),
        icons: value["icons"].as_array().cloned().unwrap_or_default(),
    })
}

fn flows() -> &'static Mutex<HashMap<String, Flow>> {
    static FLOWS: OnceLock<Mutex<HashMap<String, Flow>>> = OnceLock::new();
    FLOWS.get_or_init(Default::default)
}

async fn connection_lock(url: &str) -> Arc<Mutex<()>> {
    static LOCKS: OnceLock<Mutex<HashMap<String, Arc<Mutex<()>>>>> = OnceLock::new();
    LOCKS
        .get_or_init(Default::default)
        .lock()
        .await
        .entry(url.into())
        .or_default()
        .clone()
}

fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

pub fn normalize_url(input: &str) -> Result<String> {
    let url = Url::parse(input.trim()).map_err(|_| "Enter a valid MCP server URL.")?;
    let loopback = matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
    if !(url.scheme() == "https" || (url.scheme() == "http" && loopback))
        || url.host_str().is_none()
    {
        return Err("Use HTTPS, or HTTP for a local MCP server.".into());
    }
    if !url.username().is_empty() || url.password().is_some() || url.fragment().is_some() {
        return Err("Put credentials in authentication settings, not in the server URL.".into());
    }
    Ok(url.into())
}

fn path_for(url: &str) -> PathBuf {
    crate::storage::grove_dir()
        .join("mcp-connections")
        .join(format!("{}.json", hex::encode(Sha256::digest(url))))
}

fn read(path: &std::path::Path, url: &str) -> Result<Connection> {
    match std::fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map_err(|_| "Could not read saved MCP credentials.".into()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Connection {
            url: url.into(),
            ..Default::default()
        }),
        Err(_) => Err("Could not read saved MCP credentials.".into()),
    }
}

fn save(path: &std::path::Path, connection: &Connection) -> Result<()> {
    use std::io::Write;
    let parent = path.parent().ok_or("Invalid credential path.")?;
    std::fs::create_dir_all(parent).map_err(|_| "Could not create MCP credential directory.")?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o700))
            .map_err(|_| "Could not protect MCP credential directory.")?;
    }
    let temp = parent.join(format!(".{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| -> std::io::Result<()> {
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temp)?;
        file.write_all(&serde_json::to_vec(connection)?)?;
        file.sync_all()?;
        std::fs::rename(&temp, path)
    })();
    let _ = std::fs::remove_file(&temp);
    result.map_err(|_| "Could not save MCP credentials.".into())
}

fn summary(c: Connection) -> ConnectionSummary {
    let expires_at = c.token.as_ref().and_then(|t| t.expires_at);
    let status = if c.auth_required {
        "auth_required"
    } else if c.error.is_some() {
        "error"
    } else if c.token.is_some() && expires_at.is_some_and(|t| t <= now()) {
        "expired"
    } else if c.token.is_some() {
        "authorized"
    } else if c.checked_at.is_some() {
        "public"
    } else {
        "unchecked"
    };
    ConnectionSummary {
        url: c.url,
        status: status.into(),
        has_credentials: c.token.is_some(),
        auth_type: if c.oauth.is_some() {
            "oauth"
        } else if c.auth_required {
            "manual"
        } else {
            "none"
        }
        .into(),
        server_info: c.info,
        checked_at: c.checked_at,
        expires_at,
        scopes: c.token.map(|t| t.scopes).unwrap_or_default(),
        error: c.error,
    }
}

pub fn connection_summary(url: &str) -> Result<ConnectionSummary> {
    let url = normalize_url(url)?;
    Ok(summary(read(&path_for(&url), &url)?))
}

fn http() -> Result<Client> {
    Client::builder()
        .user_agent(concat!("Grove/", env!("CARGO_PKG_VERSION")))
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|_| "Could not start MCP connection.".into())
}

async fn bounded_body(mut response: reqwest::Response) -> Result<Vec<u8>> {
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "Could not read the server response.")?
    {
        if bytes.len() + chunk.len() > MAX_BODY {
            return Err("Server response is too large.".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

async fn get_json(client: &Client, url: &str) -> Result<Value> {
    normalize_url(url)?;
    let response = client
        .get(url)
        .send()
        .await
        .map_err(|_| "Could not fetch authorization metadata.")?;
    if !response.status().is_success() {
        return Err(format!(
            "Metadata endpoint returned HTTP {}.",
            response.status().as_u16()
        ));
    }
    serde_json::from_slice(&bounded_body(response).await?)
        .map_err(|_| "Invalid authorization metadata.".into())
}

fn challenge(headers: &HeaderMap, key: &str) -> Option<String> {
    let pattern = regex::Regex::new(&format!(
        r#"(?i)(?:\b){}\s*=\s*(?:"([^"]*)"|([^,\s]+))"#,
        regex::escape(key)
    ))
    .ok()?;
    headers
        .get_all(reqwest::header::WWW_AUTHENTICATE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .find_map(|v| {
            let captures = pattern.captures(v)?;
            captures
                .get(1)
                .or_else(|| captures.get(2))
                .map(|m| m.as_str().into())
        })
}

fn well_known(url: &Url, kind: &str) -> String {
    format!(
        "{}/.well-known/{}{}",
        url.origin().ascii_serialization(),
        kind,
        url.path().trim_end_matches('/')
    )
}

fn strings(v: &Value) -> Vec<String> {
    v.as_array()
        .map(|a| {
            a.iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

async fn discover_oauth(
    client: &Client,
    target: &str,
    headers: &HeaderMap,
) -> Result<OAuthMetadata> {
    let url = Url::parse(target).map_err(|_| "Invalid server URL.")?;
    let candidates = if let Some(location) = challenge(headers, "resource_metadata") {
        vec![location]
    } else {
        vec![
            well_known(&url, "oauth-protected-resource"),
            format!(
                "{}/.well-known/oauth-protected-resource",
                url.origin().ascii_serialization()
            ),
        ]
    };
    let mut protected = None;
    for candidate in candidates {
        if let Ok(value) = get_json(client, &candidate).await {
            protected = Some(value);
            break;
        }
    }
    let protected = protected.ok_or("This server requires credentials but does not publish MCP OAuth metadata. Configure its required headers instead.")?;
    let resource = protected["resource"]
        .as_str()
        .ok_or("Missing OAuth resource identifier.")?
        .to_string();
    normalize_url(&resource)?;
    let resource_url = Url::parse(&resource).map_err(|_| "Invalid OAuth resource identifier.")?;
    let resource_path = resource_url.path().trim_end_matches('/');
    if resource_url.origin() != url.origin()
        || !(url.path() == resource_path || url.path().starts_with(&format!("{resource_path}/")))
    {
        return Err("OAuth resource does not match this MCP server.".into());
    }
    let issuer = protected["authorization_servers"]
        .as_array()
        .and_then(|a| a.first())
        .and_then(Value::as_str)
        .ok_or("Missing authorization server.")?
        .to_string();
    let issuer_url =
        Url::parse(&normalize_url(&issuer)?).map_err(|_| "Invalid authorization server.")?;
    let mut metadata = None;
    for candidate in [
        well_known(&issuer_url, "oauth-authorization-server"),
        well_known(&issuer_url, "openid-configuration"),
        format!(
            "{}/.well-known/openid-configuration",
            issuer.trim_end_matches('/')
        ),
    ] {
        if let Ok(value) = get_json(client, &candidate).await {
            if value["issuer"].as_str() != Some(&issuer) {
                return Err("Authorization server issuer mismatch.".into());
            }
            metadata = Some(value);
            break;
        }
    }
    let value = metadata.ok_or("Could not discover the authorization server.")?;
    if !strings(&value["code_challenge_methods_supported"])
        .iter()
        .any(|s| s == "S256")
    {
        return Err("The authorization server must support PKCE S256.".into());
    }
    let endpoint = |key: &str| -> Result<String> {
        normalize_url(
            value[key]
                .as_str()
                .ok_or_else(|| format!("Missing {key}."))?,
        )
    };
    let optional = |key: &str| -> Result<Option<String>> {
        value[key].as_str().map(normalize_url).transpose()
    };
    Ok(OAuthMetadata {
        issuer,
        resource,
        authorization_endpoint: endpoint("authorization_endpoint")?,
        token_endpoint: endpoint("token_endpoint")?,
        registration_endpoint: optional("registration_endpoint")?,
        revocation_endpoint: optional("revocation_endpoint")?,
        scopes: challenge(headers, "scope")
            .map(|s| s.split_whitespace().map(str::to_string).collect())
            .unwrap_or_else(|| strings(&protected["scopes_supported"])),
        auth_methods: strings(&value["token_endpoint_auth_methods_supported"]),
        response_iss_required: value["authorization_response_iss_parameter_supported"] == true,
        cimd_supported: value["client_id_metadata_document_supported"] == true,
    })
}

fn parse_rpc(bytes: &[u8], id: u64) -> Option<Value> {
    if let Ok(value) = serde_json::from_slice::<Value>(bytes) {
        return (value["id"] == id).then_some(value);
    }
    let text = String::from_utf8_lossy(bytes).replace("\r\n", "\n");
    text.split("\n\n").find_map(|event| {
        let data = event
            .lines()
            .filter_map(|line| line.strip_prefix("data:").map(str::trim_start))
            .collect::<Vec<_>>()
            .join("\n");
        let value: Value = serde_json::from_str(&data).ok()?;
        (value["id"] == id).then_some(value)
    })
}

async fn rpc(
    client: &Client,
    url: &str,
    body: &Value,
    token: Option<&str>,
    headers: &HashMap<String, String>,
    session: Option<&str>,
    version: Option<&str>,
) -> Result<(StatusCode, HeaderMap, Value)> {
    let mut request = client
        .post(url)
        .header("Accept", "application/json, text/event-stream")
        .json(body);
    for (name, value) in headers {
        request = request.header(name, value);
    }
    if let Some(token) = token {
        request = request.bearer_auth(token);
    }
    if let Some(session) = session {
        request = request.header("Mcp-Session-Id", session);
    }
    if let Some(version) = version {
        request = request.header("MCP-Protocol-Version", version);
    }
    if body["method"] == "server/discover" {
        request = request.header("Mcp-Method", "server/discover");
    }
    let response = request
        .send()
        .await
        .map_err(|_| "Could not reach the MCP server. Check the URL and try again.")?;
    let status = response.status();
    let headers = response.headers().clone();
    // SSE streams can stay open after the response. Stop at our response frame.
    let mut response = response;
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "Could not read the MCP response.")?
    {
        if bytes.len() + chunk.len() > MAX_BODY {
            return Err("MCP response is too large.".into());
        }
        bytes.extend_from_slice(&chunk);
        if let Some(result) = parse_rpc(&bytes, body["id"].as_u64().unwrap_or(0)) {
            return Ok((status, headers, result));
        }
    }
    Ok((status, headers, Value::Null))
}

fn token_request(
    client: &Client,
    endpoint: &str,
    client_id: &str,
    secret: Option<&str>,
    methods: &[String],
    fields: Vec<(&str, String)>,
) -> reqwest::RequestBuilder {
    let mut fields = fields;
    let mut request = client.post(endpoint);
    if let Some(secret) = secret {
        if methods.iter().any(|m| m == "client_secret_post")
            && !methods.iter().any(|m| m == "client_secret_basic")
        {
            fields.push(("client_id", client_id.into()));
            fields.push(("client_secret", secret.into()));
        } else {
            request = request.basic_auth(client_id, Some(secret));
        }
    } else {
        fields.push(("client_id", client_id.into()));
    }
    request.form(&fields)
}

fn parse_token(
    value: Value,
    previous: Option<&Token>,
    requested_scopes: &[String],
) -> Result<Token> {
    if !value["token_type"]
        .as_str()
        .is_some_and(|t| t.eq_ignore_ascii_case("bearer"))
    {
        return Err("The authorization server did not issue a Bearer token.".into());
    }
    let access_token = value["access_token"]
        .as_str()
        .filter(|s| !s.is_empty())
        .ok_or("Missing access token.")?
        .to_string();
    Ok(Token {
        access_token,
        refresh_token: value["refresh_token"]
            .as_str()
            .map(str::to_string)
            .or_else(|| previous.and_then(|p| p.refresh_token.clone())),
        expires_at: value["expires_in"]
            .as_u64()
            .map(|s| now().saturating_add(s)),
        scopes: value["scope"]
            .as_str()
            .map(|s| s.split_whitespace().map(str::to_string).collect())
            .unwrap_or_else(|| requested_scopes.to_vec()),
    })
}

struct TokenFailure {
    message: String,
    reauthorize: bool,
}

impl TokenFailure {
    fn retry(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            reauthorize: false,
        }
    }
}

async fn obtain_token(
    request: reqwest::RequestBuilder,
    previous: Option<&Token>,
    scopes: &[String],
) -> std::result::Result<Token, TokenFailure> {
    let response = request.send().await.map_err(|_| {
        TokenFailure::retry(
            "Could not contact the token endpoint. Check your connection and try again.",
        )
    })?;
    if !response.status().is_success() {
        let status = response.status();
        let bytes = bounded_body(response).await.map_err(TokenFailure::retry)?;
        let error: Value = serde_json::from_slice(&bytes).unwrap_or_default();
        let reauthorize = matches!(
            error["error"].as_str(),
            Some(
                "invalid_grant"
                    | "invalid_client"
                    | "unauthorized_client"
                    | "access_denied"
                    | "interaction_required"
                    | "login_required"
            )
        ) || status == StatusCode::UNAUTHORIZED;
        return Err(TokenFailure {
            reauthorize,
            message: if reauthorize {
                "Authorization is no longer valid. Reauthorize this server in Grove.".into()
            } else {
                format!(
                    "The provider could not refresh this connection (HTTP {}). Try again.",
                    status.as_u16()
                )
            },
        });
    }
    let value = serde_json::from_slice(&bounded_body(response).await.map_err(TokenFailure::retry)?)
        .map_err(|_| TokenFailure::retry("Invalid token response."))?;
    parse_token(value, previous, scopes).map_err(TokenFailure::retry)
}

async fn valid_token(c: &mut Connection, path: &std::path::Path) -> Result<Option<String>> {
    if c.auth_required {
        return Err(
            "MCP authorization is required. Open Extensions to authorize this server.".into(),
        );
    }
    let Some(token) = c.token.as_ref() else {
        return Ok(None);
    };
    if token.expires_at.is_none_or(|t| t > now() + 30) {
        return Ok(Some(token.access_token.clone()));
    }
    let Some(refresh) = token.refresh_token.as_ref() else {
        c.auth_required = true;
        save(path, c)?;
        return Err("MCP authorization expired. Reauthorize in Extensions.".into());
    };
    let oauth = c
        .oauth
        .as_ref()
        .ok_or("Missing saved OAuth configuration.")?;
    let request = token_request(
        &http()?,
        &oauth.token_endpoint,
        c.client_id.as_deref().ok_or("Missing OAuth client ID.")?,
        c.client_secret.as_deref(),
        &oauth.auth_methods,
        vec![
            ("grant_type", "refresh_token".into()),
            ("refresh_token", refresh.clone()),
            ("resource", oauth.resource.clone()),
        ],
    );
    match obtain_token(request, Some(token), &token.scopes).await {
        Ok(token) => {
            let access = token.access_token.clone();
            c.token = Some(token);
            c.error = None;
            save(path, c)?;
            Ok(Some(access))
        }
        Err(error) => {
            c.auth_required = error.reauthorize;
            c.error = Some(error.message.clone());
            save(path, c)?;
            Err(error.message)
        }
    }
}

/// Called only when preparing a new Agent connection, never during a running call.
pub async fn authorize_configs(
    configs: &mut [crate::storage::extensions::ResolvedMcpConfig],
) -> Result<()> {
    for config in configs {
        if config.transport == "stdio" {
            continue;
        }
        let Some(url) = config.url.as_deref() else {
            continue;
        };
        let url = normalize_url(url)?;
        let path = path_for(&url);
        let lock = connection_lock(&url).await;
        let _guard = lock.lock().await;
        let mut c = read(&path, &url)?;
        // Manually supplied credentials are still supported for non-OAuth servers.
        if c.oauth.is_none() && !config.headers.is_empty() {
            continue;
        }
        if let Some(token) = valid_token(&mut c, &path).await? {
            config
                .headers
                .retain(|name, _| !name.eq_ignore_ascii_case("authorization"));
            config
                .headers
                .insert("Authorization".into(), format!("Bearer {token}"));
        }
    }
    Ok(())
}

pub async fn probe(input: &str, headers: HashMap<String, String>) -> Result<ConnectionSummary> {
    let url = normalize_url(input)?;
    let lock = connection_lock(&url).await;
    let _guard = lock.lock().await;
    let path = path_for(&url);
    let mut c = read(&path, &url)?;
    let result = probe_inner(&mut c, &path, headers).await;
    c.checked_at = Some(now());
    c.error = result.err();
    save(&path, &c)?;
    Ok(summary(c))
}

async fn probe_inner(
    c: &mut Connection,
    path: &std::path::Path,
    headers: HashMap<String, String>,
) -> Result<()> {
    let client = http()?;
    let token = if c.auth_required {
        // A previous probe may have marked the connection as requiring auth
        // even though a usable grant is saved. Explicit checks must retry that
        // access token; otherwise every Retry sends an anonymous request.
        c.token
            .as_ref()
            .filter(|token| token.expires_at.is_none_or(|expiry| expiry > now()))
            .map(|token| token.access_token.clone())
    } else {
        valid_token(c, path).await?
    };
    if token.is_some() {
        c.auth_required = false;
    }
    let mut modern = true;
    let version = "2026-07-28".to_string();
    let mut response = rpc(&client, &c.url, &json!({"jsonrpc":"2.0","id":1,"method":"server/discover","params":{"_meta":{"io.modelcontextprotocol/protocolVersion":version,"io.modelcontextprotocol/clientCapabilities":{}}}}), token.as_deref(), &headers, None, Some(&version)).await?;
    if response.2["error"]["code"] == -32022 {
        return Err("This MCP server uses an unsupported protocol version.".into());
    }
    if !matches!(response.0, StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN)
        && response.2["result"]["supportedVersions"].is_null()
    {
        modern = false;
        response = rpc(&client, &c.url, &json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"Grove","version":env!("CARGO_PKG_VERSION")}}}), token.as_deref(), &headers, None, None).await?;
    }
    // A provider or gateway may reject an HTTP client without challenging
    // its OAuth grant. Only a 401 or an actual Bearer challenge is an auth
    // failure; an ordinary 403 must remain a connection error.
    let bearer_challenge = response
        .1
        .get_all(reqwest::header::WWW_AUTHENTICATE)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .any(|value| value.to_ascii_lowercase().contains("bearer"));
    if response.0 == StatusCode::UNAUTHORIZED
        || (response.0 == StatusCode::FORBIDDEN && bearer_challenge)
    {
        c.auth_required = true;
        match discover_oauth(&client, &c.url, &response.1).await {
            Ok(oauth) => {
                if c.oauth
                    .as_ref()
                    .is_some_and(|old| old.issuer != oauth.issuer)
                {
                    c.token = None;
                    c.client_id = None;
                    c.client_secret = None;
                }
                c.oauth = Some(oauth);
                return Ok(());
            }
            Err(e) => return Err(e),
        }
    }
    if !response.0.is_success() || !response.2["error"].is_null() {
        return Err(format!(
            "Could not initialize MCP server (HTTP {}).",
            response.0.as_u16()
        ));
    }
    let result = &response.2["result"];
    let info = if modern {
        &result["_meta"]["io.modelcontextprotocol/serverInfo"]
    } else {
        &result["serverInfo"]
    };
    c.info = Some(server_info(info).ok_or("The server did not provide its name.")?);
    c.auth_required = false;
    // Discovery does not execute tools. Close the short-lived legacy session.
    if !modern {
        if let Some(session) = response
            .1
            .get("mcp-session-id")
            .and_then(|v| v.to_str().ok())
        {
            let mut close = client
                .delete(&c.url)
                .header("Mcp-Session-Id", session)
                .header(
                    "MCP-Protocol-Version",
                    result["protocolVersion"].as_str().unwrap_or("2025-11-25"),
                );
            for (name, value) in &headers {
                close = close.header(name, value);
            }
            if let Some(token) = token {
                close = close.bearer_auth(token);
            }
            let _ = close.send().await;
        }
    }
    Ok(())
}

pub async fn start_auth(
    input: &str,
    client_id: Option<String>,
    client_secret: Option<String>,
    callback_url: Option<String>,
) -> Result<FlowSummary> {
    let url = normalize_url(input)?;
    let lock = connection_lock(&url).await;
    let _guard = lock.lock().await;
    let path = path_for(&url);
    let mut c = read(&path, &url)?;
    let mut oauth = c
        .oauth
        .clone()
        .ok_or("Check this connection first to discover its authentication settings.")?;
    if let Some(token) = &c.token {
        for scope in &token.scopes {
            if !oauth.scopes.contains(scope) {
                oauth.scopes.push(scope.clone());
            }
        }
    }
    let callback = callback_url.filter(|value| !value.trim().is_empty()).map(|value| {
        let parsed = Url::parse(value.trim()).map_err(|_| "Invalid callback URL.")?;
        if parsed.scheme() != "http" || !matches!(parsed.host_str(), Some("127.0.0.1" | "localhost")) || parsed.path() != "/callback" || parsed.port().is_none() || parsed.query().is_some() || parsed.fragment().is_some() || !parsed.username().is_empty() || parsed.password().is_some() {
            return Err("Use a registered HTTP loopback callback URL with an explicit port and /callback path.");
        }
        Ok(parsed)
    }).transpose()?;
    let listener = tokio::net::TcpListener::bind((
        std::net::Ipv4Addr::LOCALHOST,
        callback.as_ref().and_then(Url::port).unwrap_or(0),
    ))
    .await
    .map_err(|_| "Could not open a local authorization callback.")?;
    let redirect_uri = callback.map(String::from).unwrap_or(format!(
        "http://127.0.0.1:{}/callback",
        listener
            .local_addr()
            .map_err(|_| "Could not open callback.")?
            .port()
    ));
    let client = http()?;
    let (client_id, client_secret) = if let Some(id) = client_id.filter(|s| !s.trim().is_empty()) {
        if id.starts_with("https://") && !oauth.cimd_supported {
            return Err(
                "This authorization server does not support Client ID Metadata Documents.".into(),
            );
        }
        (id, client_secret.filter(|s| !s.is_empty()))
    } else {
        let endpoint = oauth.registration_endpoint.as_ref().ok_or("This server needs a registered client ID. Enter it in advanced authentication settings.")?;
        let response = client.post(endpoint).json(&json!({"client_name":"Grove","application_type":"native","redirect_uris":[redirect_uri],"grant_types":["authorization_code","refresh_token"],"response_types":["code"],"token_endpoint_auth_method":"none"})).send().await.map_err(|_| "OAuth client registration failed.")?;
        if !response.status().is_success() {
            return Err(format!("OAuth client registration failed (HTTP {}). Enter a registered client ID if required.", response.status().as_u16()));
        }
        let registration: Value = serde_json::from_slice(&bounded_body(response).await?)
            .map_err(|_| "Invalid client registration response.")?;
        (
            registration["client_id"]
                .as_str()
                .ok_or("Missing registered client ID.")?
                .into(),
            registration["client_secret"]
                .as_str()
                .filter(|s| !s.is_empty())
                .map(str::to_string),
        )
    };
    let id = uuid::Uuid::new_v4().to_string();
    let (stop, stopped) = tokio::sync::oneshot::channel();
    let state = random_secret()?;
    let verifier = random_secret()?;
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(&verifier));
    c.generation = uuid::Uuid::new_v4().to_string();
    save(&path, &c)?;
    let mut authorization =
        Url::parse(&oauth.authorization_endpoint).map_err(|_| "Invalid authorization endpoint.")?;
    {
        let mut query = authorization.query_pairs_mut();
        query
            .append_pair("response_type", "code")
            .append_pair("client_id", &client_id)
            .append_pair("redirect_uri", &redirect_uri)
            .append_pair("state", &state)
            .append_pair("code_challenge", &challenge)
            .append_pair("code_challenge_method", "S256")
            .append_pair("resource", &oauth.resource);
        if !oauth.scopes.is_empty() {
            query.append_pair("scope", &oauth.scopes.join(" "));
        }
    }
    let mut pending = flows().lock().await;
    pending.retain(|_, f| f.created_at + FLOW_SECONDS > now());
    for flow in pending
        .values_mut()
        .filter(|f| f.url == url && f.status == "pending")
    {
        flow.status = "cancelled".into();
        if let Some(stop) = flow.stop.take() {
            let _ = stop.send(());
        }
    }
    pending.insert(
        id.clone(),
        Flow {
            url,
            path,
            generation: c.generation,
            state,
            verifier,
            redirect_uri,
            oauth,
            client_id,
            client_secret,
            created_at: now(),
            status: "pending".into(),
            error: None,
            stop: Some(stop),
        },
    );
    drop(pending);
    let flow_id = id.clone();
    let app = axum::Router::new().route("/callback", axum::routing::get(move |axum::extract::Query(params): axum::extract::Query<HashMap<String, String>>| {
        let flow_id = flow_id.clone();
        async move {
            let message = if finish_auth(&flow_id, params).await.is_ok() { "Authorization completed. You can close this tab and return to Grove." } else { "Authorization could not be completed. Return to Grove to retry." };
            ([(axum::http::header::CACHE_CONTROL, "no-store"), (axum::http::header::REFERRER_POLICY, "no-referrer")], axum::response::Html(format!("<!doctype html><html><head><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>Grove</title></head><body style=\"font:16px system-ui;padding:48px;line-height:1.6\"><h1>Grove</h1><p>{message}</p></body></html>")))
        }
    }));
    tokio::spawn(async move {
        let _ = axum::serve(listener, app)
            .with_graceful_shutdown(async {
                let _ = tokio::time::timeout(Duration::from_secs(FLOW_SECONDS), stopped).await;
            })
            .await;
    });
    Ok(FlowSummary {
        id,
        status: "pending".into(),
        error: None,
        authorization_url: Some(authorization.into()),
    })
}

fn random_secret() -> Result<String> {
    let mut bytes = [0u8; 32];
    getrandom::getrandom(&mut bytes).map_err(|_| "Could not generate authorization state.")?;
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}

pub async fn flow_status(id: &str) -> Result<FlowSummary> {
    let mut pending = flows().lock().await;
    let flow = pending
        .get_mut(id)
        .ok_or("Authorization session not found. Start again.")?;
    if flow.status == "pending" && flow.created_at + FLOW_SECONDS <= now() {
        flow.status = "expired".into();
        if let Some(stop) = flow.stop.take() {
            let _ = stop.send(());
        }
    }
    Ok(FlowSummary {
        id: id.into(),
        status: flow.status.clone(),
        error: flow.error.clone(),
        authorization_url: None,
    })
}

pub async fn cancel_flow(id: &str) -> Result<()> {
    let mut pending = flows().lock().await;
    let flow = pending
        .get_mut(id)
        .ok_or("Authorization session not found.")?;
    if matches!(flow.status.as_str(), "pending" | "exchanging") {
        flow.status = "cancelled".into();
        if let Some(stop) = flow.stop.take() {
            let _ = stop.send(());
        }
    }
    Ok(())
}

pub async fn finish_auth(id: &str, params: HashMap<String, String>) -> Result<()> {
    let mut pending = flows().lock().await;
    let flow = pending
        .get_mut(id)
        .ok_or("Authorization session not found.")?;
    if flow.status != "pending" || flow.created_at + FLOW_SECONDS <= now() {
        return Err("Authorization session has ended. Start again.".into());
    }
    if params.get("state") != Some(&flow.state) {
        return Err("Authorization state mismatch.".into());
    }
    if (flow.oauth.response_iss_required || params.contains_key("iss"))
        && params.get("iss") != Some(&flow.oauth.issuer)
    {
        return Err("Authorization issuer mismatch.".into());
    }
    let lock = connection_lock(&flow.url).await;
    // Do not hold the flow map while waiting for a connection lock.
    let url = flow.url.clone();
    let path = flow.path.clone();
    let generation = flow.generation.clone();
    let request = token_request(
        &http()?,
        &flow.oauth.token_endpoint,
        &flow.client_id,
        flow.client_secret.as_deref(),
        &flow.oauth.auth_methods,
        vec![
            ("grant_type", "authorization_code".into()),
            ("code", params.get("code").cloned().unwrap_or_default()),
            ("code_verifier", flow.verifier.clone()),
            ("redirect_uri", flow.redirect_uri.clone()),
            ("resource", flow.oauth.resource.clone()),
        ],
    );
    let oauth = flow.oauth.clone();
    let client_id = flow.client_id.clone();
    let secret = flow.client_secret.clone();
    flow.status = "exchanging".into();
    drop(pending);
    let _guard = lock.lock().await;
    let result = async {
        let mut c = read(&path, &url)?;
        if c.generation != generation {
            return Err("Authorization was cancelled or replaced.".into());
        }
        if params.contains_key("error") {
            return Err("Authorization was declined. You can try again.".into());
        }
        if !params.contains_key("code") {
            return Err("Missing authorization code.".into());
        }
        let token = obtain_token(request, None, &oauth.scopes)
            .await
            .map_err(|failure| failure.message)?;
        if !flows()
            .lock()
            .await
            .get(id)
            .is_some_and(|f| f.status == "exchanging")
        {
            return Err("Authorization was cancelled.".into());
        }
        c.token = Some(token);
        c.client_id = Some(client_id);
        c.client_secret = secret;
        c.oauth = Some(oauth);
        c.auth_required = false;
        c.error = None;
        save(&path, &c)
    }
    .await;
    let mut pending = flows().lock().await;
    if let Some(flow) = pending.get_mut(id) {
        flow.status = if result.is_ok() { "complete" } else { "failed" }.into();
        flow.error = result.as_ref().err().cloned();
        if let Some(stop) = flow.stop.take() {
            let _ = stop.send(());
        }
    }
    result
}

pub async fn disconnect(input: &str) -> Result<Option<String>> {
    let url = normalize_url(input)?;
    let lock = connection_lock(&url).await;
    let _guard = lock.lock().await;
    let path = path_for(&url);
    let mut c = read(&path, &url)?;
    let mut warning = None;
    if let (Some(token), Some(oauth)) = (&c.token, &c.oauth) {
        if let Some(endpoint) = &oauth.revocation_endpoint {
            let secret = token.refresh_token.as_ref().unwrap_or(&token.access_token);
            let request = token_request(
                &http()?,
                endpoint,
                c.client_id.as_deref().unwrap_or(""),
                c.client_secret.as_deref(),
                &oauth.auth_methods,
                vec![
                    ("token", secret.clone()),
                    (
                        "token_type_hint",
                        if token.refresh_token.is_some() {
                            "refresh_token"
                        } else {
                            "access_token"
                        }
                        .into(),
                    ),
                ],
            );
            if !request.send().await.is_ok_and(|r| r.status().is_success()) {
                warning = Some("Saved credentials were removed. The provider could not confirm revocation; you can also revoke access in its account settings.".into());
            }
        } else {
            warning = Some("Saved credentials were removed. This provider has no revocation endpoint; existing access tokens may remain valid until they expire.".into());
        }
    }
    c.token = None;
    c.client_id = None;
    c.client_secret = None;
    c.auth_required = true;
    c.error = None;
    c.generation = uuid::Uuid::new_v4().to_string();
    save(&path, &c)?;
    let mut pending = flows().lock().await;
    for flow in pending
        .values_mut()
        .filter(|f| f.url == url && matches!(f.status.as_str(), "pending" | "exchanging"))
    {
        flow.status = "cancelled".into();
        if let Some(stop) = flow.stop.take() {
            let _ = stop.send(());
        }
    }
    Ok(warning)
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        extract::State,
        http::HeaderMap,
        routing::{get, post},
        Form, Json, Router,
    };
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[derive(Clone)]
    struct Provider {
        base: String,
        refreshes: Arc<AtomicUsize>,
        revocations: Arc<AtomicUsize>,
        challenges: Arc<Mutex<HashMap<String, String>>>,
    }

    async fn provider() -> (Provider, tokio::task::JoinHandle<()>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let provider = Provider {
            base: format!("http://{}", listener.local_addr().unwrap()),
            refreshes: Arc::default(),
            revocations: Arc::default(),
            challenges: Arc::default(),
        };
        let app = Router::new()
            .route("/mcp", post(|State(p): State<Provider>, headers: HeaderMap, Json(body): Json<Value>| async move {
                if headers.get("authorization").and_then(|h| h.to_str().ok()).is_none_or(|h| !matches!(h, "Bearer access-one" | "Bearer access-two")) {
                    return (StatusCode::UNAUTHORIZED, [("www-authenticate", format!("Bearer resource_metadata=\"{}/.well-known/oauth-protected-resource/mcp\", scope=\"read\"", p.base))], Json(json!({}))).into_response();
                }
                if body["method"] == "server/discover" {
                    assert_eq!(headers["mcp-method"], "server/discover");
                    return Json(json!({"jsonrpc":"2.0","id":1,"result":{"supportedVersions":["2026-07-28"],"_meta":{"io.modelcontextprotocol/serverInfo":{"name":"test-mcp","title":"Test MCP","version":"2.4.0","description":"Provider description"}}}})).into_response();
                }
                panic!("Discovery must not execute tools");
            }))
            .route("/.well-known/oauth-protected-resource/mcp", get(|State(p): State<Provider>| async move { Json(json!({"resource":format!("{}/mcp",p.base),"authorization_servers":[format!("{}/auth",p.base)],"scopes_supported":["read","write"]})) }))
            .route("/.well-known/oauth-authorization-server/auth", get(|State(p): State<Provider>| async move { Json(json!({"issuer":format!("{}/auth",p.base),"authorization_endpoint":format!("{}/authorize",p.base),"token_endpoint":format!("{}/token",p.base),"registration_endpoint":format!("{}/register",p.base),"revocation_endpoint":format!("{}/revoke",p.base),"response_types_supported":["code"],"code_challenge_methods_supported":["S256"],"token_endpoint_auth_methods_supported":["none"],"authorization_response_iss_parameter_supported":true})) }))
            .route("/register", post(|Json(value): Json<Value>| async move {
                assert_eq!(value["application_type"], "native");
                Json(json!({"client_id":"grove-test"}))
            }))
            .route("/token", post(|State(p): State<Provider>, Form(form): Form<HashMap<String,String>>| async move {
                assert_eq!(form["resource"], format!("{}/mcp", p.base));
                assert_eq!(form["client_id"], "grove-test");
                if form["grant_type"] == "refresh_token" {
                    assert_eq!(form["refresh_token"], "refresh-one");
                    p.refreshes.fetch_add(1, Ordering::SeqCst);
                    Json(json!({"access_token":"access-two","token_type":"Bearer","expires_in":3600}))
                } else {
                    let challenge = p.challenges.lock().await.get("challenge").unwrap().clone();
                    assert_eq!(URL_SAFE_NO_PAD.encode(Sha256::digest(&form["code_verifier"])), challenge);
                    assert_eq!(form["code"], "valid-code");
                    Json(json!({"access_token":"access-one","refresh_token":"refresh-one","token_type":"Bearer","expires_in":3600,"scope":"read"}))
                }
            }))
            .route("/revoke", post(|State(p): State<Provider>, Form(form): Form<HashMap<String,String>>| async move {
                assert_eq!(form["token"], "refresh-one");
                p.revocations.fetch_add(1, Ordering::SeqCst);
                StatusCode::OK
            }))
            .with_state(provider.clone());
        use axum::response::IntoResponse;
        let handle = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        (provider, handle)
    }

    struct TestDir(tempfile::TempDir);
    impl TestDir {
        fn new() -> Self {
            let dir = Self(tempfile::tempdir().unwrap());
            crate::storage::set_grove_dir_override(Some(dir.0.path().into()));
            dir
        }
    }
    impl Drop for TestDir {
        fn drop(&mut self) {
            crate::storage::set_grove_dir_override(None);
        }
    }

    fn config(url: &str) -> crate::storage::extensions::ResolvedMcpConfig {
        crate::storage::extensions::ResolvedMcpConfig {
            name: "test".into(),
            transport: "streamable-http".into(),
            url: Some(url.into()),
            command: None,
            args: vec![],
            env: HashMap::new(),
            headers: HashMap::new(),
        }
    }

    #[tokio::test]
    async fn package_stdio_negotiates_legacy_and_reads_metadata_without_executing_tools() {
        use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
        let (client, server) = tokio::io::duplex(8192);
        let (client_read, mut client_write) = tokio::io::split(client);
        let mut client_read = BufReader::new(client_read);
        let fixture = tokio::spawn(async move {
            let (read, mut write) = tokio::io::split(server);
            let mut lines = BufReader::new(read).lines();
            let discover: Value =
                serde_json::from_str(&lines.next_line().await.unwrap().unwrap()).unwrap();
            assert_eq!(discover["method"], "server/discover");
            write
                .write_all(b"{\"jsonrpc\":\"2.0\",\"id\":1,\"error\":{\"code\":-32601}}\n")
                .await
                .unwrap();
            let initialize: Value =
                serde_json::from_str(&lines.next_line().await.unwrap().unwrap()).unwrap();
            assert_eq!(initialize["method"], "initialize");
            let reply = json!({"jsonrpc":"2.0","id":2,"result":{"protocolVersion":"2025-11-25","capabilities":{"tools":{}},"serverInfo":{"name":"package-server","title":"Package Server","version":"4.2.0","description":"Detected description","websiteUrl":"https://example.com","icons":[{"src":"https://example.com/icon.png","theme":"light"}]}}});
            write
                .write_all(format!("{reply}\n").as_bytes())
                .await
                .unwrap();
            let notification: Value =
                serde_json::from_str(&lines.next_line().await.unwrap().unwrap()).unwrap();
            assert_eq!(notification["method"], "notifications/initialized");
            let request: Value =
                serde_json::from_str(&lines.next_line().await.unwrap().unwrap()).unwrap();
            assert_eq!(request["method"], "tools/list");
            write.write_all(b"{\"jsonrpc\":\"2.0\",\"id\":3,\"result\":{\"tools\":[{\"name\":\"read_example\"}]}}\n").await.unwrap();
        });
        let (info, count) = package_handshake(&mut client_write, &mut client_read)
            .await
            .unwrap();
        let info = info.unwrap();
        assert_eq!(info.title.as_deref(), Some("Package Server"));
        assert_eq!(info.version.as_deref(), Some("4.2.0"));
        assert_eq!(info.description.as_deref(), Some("Detected description"));
        assert_eq!(info.website_url.as_deref(), Some("https://example.com"));
        assert_eq!(info.icons.len(), 1);
        assert_eq!(count, Some(1));
        fixture.await.unwrap();
    }

    #[tokio::test]
    async fn package_modern_discovery_allows_optional_metadata_and_reports_bad_stdout() {
        use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
        let (client, server) = tokio::io::duplex(8192);
        let (read, mut write) = tokio::io::split(client);
        let mut read = BufReader::new(read);
        let fixture = tokio::spawn(async move {
            let (read, mut write) = tokio::io::split(server);
            let mut lines = BufReader::new(read).lines();
            let _ = lines.next_line().await.unwrap();
            write.write_all(b"{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"supportedVersions\":[\"2026-07-28\"],\"capabilities\":{}}}\n").await.unwrap();
        });
        let (info, count) = package_handshake(&mut write, &mut read).await.unwrap();
        assert!(info.is_none());
        assert!(count.is_none());
        fixture.await.unwrap();
        let mut bad_output = BufReader::new(&b"not a protocol message\n"[..]);
        let mut sink = tokio::io::sink();
        assert!(package_response(&mut sink, &mut bad_output, 1)
            .await
            .unwrap_err()
            .contains("valid MCP messages"));
        let mut closed = BufReader::new(&b""[..]);
        assert!(package_response(&mut sink, &mut closed, 1)
            .await
            .unwrap_err()
            .contains("server exited"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn cancelling_package_probe_terminates_process_and_removes_workspace() {
        let temp = tempfile::tempdir().unwrap();
        let cwd = temp.path().join("probe");
        let mut config = config("");
        config.command = Some("/bin/sh".into());
        config.args = vec!["-c".into(), "echo $$ > probe.pid; exec sleep 60".into()];
        let path = cwd.clone();
        let task = tokio::spawn(probe_package_process(config, path, None));
        let pid_path = cwd.join("probe.pid");
        for _ in 0..100 {
            if pid_path.exists() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        let pid: i32 = std::fs::read_to_string(&pid_path)
            .unwrap()
            .trim()
            .parse()
            .unwrap();
        task.abort();
        assert!(task.await.unwrap_err().is_cancelled());
        for _ in 0..100 {
            if unsafe { libc::kill(pid, 0) } != 0 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert_ne!(unsafe { libc::kill(pid, 0) }, 0);
        assert!(!cwd.exists());
    }

    #[tokio::test]
    #[ignore = "Starts a published MCP package; requires its runtime and network access"]
    async fn live_package_discovery() {
        let _dir = TestDir::new();
        let package = std::env::var("GROVE_MCP_LIVE_PACKAGE").ok()
            .map(|value| serde_json::from_str(&value).unwrap())
            .unwrap_or_else(|| json!({"registryType":"npm","identifier":"@modelcontextprotocol/server-everything","version":"2.0.1"}));
        let started = start_package_probe(package, HashMap::new()).await.unwrap();
        let result = loop {
            let snapshot = package_probe_status(&started.id).unwrap();
            if snapshot.status != "pending" {
                break snapshot;
            }
            tokio::time::sleep(Duration::from_millis(250)).await;
        };
        cancel_package_probe(&started.id);
        assert_eq!(result.status, "complete", "{:?}", result.error);
        let info = result.server_info.unwrap();
        assert!(!info.name.is_empty());
        assert!(info.version.is_some());
        assert!(result.tool_count.is_some_and(|count| count > 0));
        println!(
            "Published MCP package discovered: {} {:?}, {} tools",
            info.name,
            info.version,
            result.tool_count.unwrap()
        );
    }

    #[tokio::test]
    async fn oauth_discovery_callback_refresh_injection_and_revocation() {
        let _dir = TestDir::new();
        let (provider, server) = provider().await;
        let url = format!("{}/mcp", provider.base);
        let initial = probe(&url, HashMap::new()).await.unwrap();
        assert_eq!(initial.status, "auth_required");
        assert_eq!(initial.auth_type, "oauth");
        let flow = start_auth(&url, None, None, None).await.unwrap();
        let authorize = Url::parse(flow.authorization_url.as_deref().unwrap()).unwrap();
        let parameters: HashMap<String, String> = authorize
            .query_pairs()
            .map(|(k, v)| (k.into_owned(), v.into_owned()))
            .collect();
        assert_eq!(parameters["scope"], "read");
        assert_eq!(parameters["code_challenge_method"], "S256");
        provider
            .challenges
            .lock()
            .await
            .insert("challenge".into(), parameters["code_challenge"].clone());
        let callback = HashMap::from([
            ("state".into(), parameters["state"].clone()),
            ("code".into(), "valid-code".into()),
            ("iss".into(), format!("{}/auth", provider.base)),
        ]);
        let mut invalid = callback.clone();
        invalid.insert("state".into(), "wrong".into());
        assert!(finish_auth(&flow.id, invalid).await.is_err());
        let mut invalid = callback.clone();
        invalid.insert("iss".into(), "https://other.example".into());
        assert!(finish_auth(&flow.id, invalid).await.is_err());
        // Complete through the real browser callback listener, including state and issuer.
        let mut callback_url = Url::parse(&parameters["redirect_uri"]).unwrap();
        callback_url.query_pairs_mut().extend_pairs(&callback);
        let response = http().unwrap().get(callback_url).send().await.unwrap();
        assert!(response
            .text()
            .await
            .unwrap()
            .contains("Authorization completed"));
        assert_eq!(flow_status(&flow.id).await.unwrap().status, "complete");
        assert!(finish_auth(&flow.id, callback).await.is_err()); // one-time code/state
        let connected = probe(&url, HashMap::new()).await.unwrap();
        assert_eq!(
            connected.server_info.as_ref().unwrap().version.as_deref(),
            Some("2.4.0")
        );
        let public_json = serde_json::to_string(&connected).unwrap();
        assert!(!public_json.contains("access-one") && !public_json.contains("refresh-one"));
        let path = path_for(&url);
        let mut saved = read(&path, &url).unwrap();
        saved.token.as_mut().unwrap().expires_at = Some(now() - 1);
        save(&path, &saved).unwrap();
        let mut first = vec![config(&url)];
        let mut second = vec![config(&url)];
        let (one, two) = tokio::join!(
            authorize_configs(&mut first),
            authorize_configs(&mut second)
        );
        one.unwrap();
        two.unwrap();
        assert_eq!(provider.refreshes.load(Ordering::SeqCst), 1);
        assert_eq!(first[0].headers["Authorization"], "Bearer access-two");
        assert_eq!(
            read(&path, &url)
                .unwrap()
                .token
                .unwrap()
                .refresh_token
                .as_deref(),
            Some("refresh-one")
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        assert!(disconnect(&url).await.unwrap().is_none());
        assert_eq!(provider.revocations.load(Ordering::SeqCst), 1);
        assert!(!std::fs::read_to_string(&path)
            .unwrap()
            .contains("refresh-one"));
        assert!(authorize_configs(&mut first).await.is_err());
        server.abort();
    }

    #[tokio::test]
    async fn cancelled_and_disconnected_flows_cannot_restore_credentials() {
        let _dir = TestDir::new();
        let (provider, server) = provider().await;
        let url = format!("{}/mcp", provider.base);
        probe(&url, HashMap::new()).await.unwrap();
        for disconnect_grant in [false, true] {
            let flow = start_auth(&url, None, None, None).await.unwrap();
            let auth = Url::parse(flow.authorization_url.as_deref().unwrap()).unwrap();
            let state = auth
                .query_pairs()
                .find(|(k, _)| k == "state")
                .unwrap()
                .1
                .into_owned();
            if disconnect_grant {
                disconnect(&url).await.unwrap();
            } else {
                cancel_flow(&flow.id).await.unwrap();
            }
            assert!(finish_auth(
                &flow.id,
                HashMap::from([
                    ("state".into(), state),
                    ("code".into(), "valid-code".into()),
                    ("iss".into(), format!("{}/auth", provider.base))
                ])
            )
            .await
            .is_err());
            assert!(!connection_summary(&url).unwrap().has_credentials);
        }
        server.abort();
    }

    #[tokio::test]
    async fn legacy_streamable_http_metadata_and_session_cleanup() {
        use axum::response::IntoResponse;
        let _dir = TestDir::new();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/mcp", listener.local_addr().unwrap());
        let closed = Arc::new(AtomicUsize::new(0));
        let count = closed.clone();
        let app = Router::new().route("/mcp", post(|Json(body): Json<Value>| async move {
            if body["method"] == "server/discover" {
                return (StatusCode::BAD_REQUEST, Json(json!({"jsonrpc":"2.0","id":1,"error":{"code":-32601,"message":"unknown method"}}))).into_response();
            }
            assert_eq!(body["method"], "initialize");
            ([("mcp-session-id", "session")], [("content-type", "text/event-stream")], "event: message\ndata: {\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"protocolVersion\":\"2025-11-25\",\"serverInfo\":{\"name\":\"legacy\",\"version\":\"1.2.3\"}}}\n\n").into_response()
        }).delete(move |headers: HeaderMap| {
            let count = count.clone();
            async move { assert_eq!(headers["mcp-session-id"], "session"); count.fetch_add(1, Ordering::SeqCst); StatusCode::OK }
        }));
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        let result = probe(&url, HashMap::new()).await.unwrap();
        assert_eq!(result.status, "public");
        assert_eq!(
            result.server_info.unwrap().version.as_deref(),
            Some("1.2.3")
        );
        assert_eq!(closed.load(Ordering::SeqCst), 1);
        server.abort();
    }

    #[tokio::test]
    async fn retry_recovers_a_saved_grant_with_a_stale_auth_required_flag() {
        use axum::response::IntoResponse;
        let _dir = TestDir::new();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/mcp", listener.local_addr().unwrap());
        let app = Router::new().route("/mcp", post(|headers: HeaderMap, Json(body): Json<Value>| async move {
            assert_eq!(headers["user-agent"], concat!("Grove/", env!("CARGO_PKG_VERSION")));
            assert_eq!(headers["authorization"], "Bearer saved-grant");
            if body["method"] == "server/discover" {
                // Monarch rejects newer protocol versions with a generic
                // error ID; the client must still initialize the older era.
                return (StatusCode::BAD_REQUEST, Json(json!({"jsonrpc":"2.0","id":"server-error","error":{"code":-32600,"message":"Unsupported protocol version"}}))).into_response();
            }
            assert_eq!(body["method"], "initialize");
            ([("content-type", "text/event-stream")], "event: message\ndata: {\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"protocolVersion\":\"2025-11-25\",\"serverInfo\":{\"name\":\"Monarch Money\",\"version\":\"3.3.1\"}}}\n\n").into_response()
        }));
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        let path = path_for(&url);
        save(
            &path,
            &Connection {
                url: url.clone(),
                auth_required: true,
                token: Some(Token {
                    access_token: "saved-grant".into(),
                    refresh_token: Some("refresh".into()),
                    expires_at: Some(now() + 600),
                    scopes: vec![],
                }),
                ..Default::default()
            },
        )
        .unwrap();
        let result = probe(&url, HashMap::new()).await.unwrap();
        assert_eq!(result.status, "authorized");
        let info = result.server_info.unwrap();
        assert_eq!(info.name, "Monarch Money");
        assert_eq!(info.version.as_deref(), Some("3.3.1"));
        assert!(!read(&path, &url).unwrap().auth_required);
        server.abort();
    }

    #[tokio::test]
    async fn ordinary_forbidden_responses_do_not_invalidate_saved_authorization() {
        let _dir = TestDir::new();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/mcp", listener.local_addr().unwrap());
        let app = Router::new().route(
            "/mcp",
            post(|| async { (StatusCode::FORBIDDEN, Json(json!({"You":"Shall Not Pass"}))) }),
        );
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        let path = path_for(&url);
        save(
            &path,
            &Connection {
                url: url.clone(),
                auth_required: true,
                token: Some(Token {
                    access_token: "saved-grant".into(),
                    refresh_token: None,
                    expires_at: Some(now() + 600),
                    scopes: vec![],
                }),
                ..Default::default()
            },
        )
        .unwrap();
        let result = probe(&url, HashMap::new()).await.unwrap();
        assert_eq!(result.status, "error");
        assert!(result.has_credentials);
        assert!(result.error.unwrap().contains("403"));
        assert!(!read(&path, &url).unwrap().auth_required);
        server.abort();
    }

    #[test]
    fn urls_and_sse_responses_are_validated() {
        assert!(normalize_url("https://user:secret@example.com/mcp").is_err());
        assert!(normalize_url("http://example.com/mcp").is_err());
        assert!(normalize_url("http://127.0.0.1:3000/mcp").is_ok());
        assert!(normalize_url("https://example.com/mcp#token").is_err());
        let bytes = b": keepalive\r\n\r\nevent: message\r\ndata: {\"jsonrpc\":\"2.0\",\"method\":\"notifications/message\"}\r\n\r\ndata: {\"jsonrpc\":\"2.0\",\"id\":1,\r\ndata: \"result\":{\"ok\":true}}\r\n\r\n";
        assert_eq!(parse_rpc(bytes, 1).unwrap()["result"]["ok"], true);
        assert!(parse_rpc(bytes, 2).is_none());
        let previous = Token {
            access_token: "old".into(),
            refresh_token: Some("refresh".into()),
            expires_at: None,
            scopes: vec!["read".into()],
        };
        let updated = parse_token(
            json!({"access_token":"new","token_type":"bearer"}),
            Some(&previous),
            &previous.scopes,
        )
        .unwrap();
        assert_eq!(updated.refresh_token.as_deref(), Some("refresh"));
        assert_eq!(updated.scopes, vec!["read"]);
    }

    #[tokio::test]
    async fn refresh_retries_transient_failures_but_requires_login_for_invalid_grants() {
        let _dir = TestDir::new();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let mode = Arc::new(AtomicUsize::new(0));
        let response_mode = mode.clone();
        let app = Router::new().route("/token", post(move || {
            let response_mode = response_mode.clone();
            async move {
                match response_mode.load(Ordering::SeqCst) {
                    0 => (StatusCode::SERVICE_UNAVAILABLE, Json(json!({"error":"temporarily_unavailable"}))),
                    1 => (StatusCode::OK, Json(json!({"access_token":"new-access","token_type":"Bearer","expires_in":3600}))),
                    _ => (StatusCode::BAD_REQUEST, Json(json!({"error":"invalid_grant","error_description":"private_token_value"}))),
                }
            }
        }));
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        let url = format!("{base}/mcp");
        let path = path_for(&url);
        let connection = Connection {
            url: url.clone(),
            client_id: Some("grove".into()),
            oauth: Some(OAuthMetadata {
                issuer: base.clone(),
                resource: url.clone(),
                authorization_endpoint: format!("{base}/authorize"),
                token_endpoint: format!("{base}/token"),
                registration_endpoint: None,
                revocation_endpoint: None,
                scopes: vec!["read".into()],
                auth_methods: vec!["none".into()],
                response_iss_required: false,
                cimd_supported: false,
            }),
            token: Some(Token {
                access_token: "old-access".into(),
                refresh_token: Some("refresh".into()),
                expires_at: Some(now() - 1),
                scopes: vec!["read".into()],
            }),
            ..Default::default()
        };
        save(&path, &connection).unwrap();
        let mut configs = vec![config(&url)];
        assert!(authorize_configs(&mut configs).await.is_err());
        let failed = read(&path, &url).unwrap();
        assert!(!failed.auth_required);
        assert_eq!(summary(failed).status, "error");
        mode.store(1, Ordering::SeqCst);
        authorize_configs(&mut configs).await.unwrap();
        assert_eq!(configs[0].headers["Authorization"], "Bearer new-access");
        let mut saved = read(&path, &url).unwrap();
        saved.token.as_mut().unwrap().expires_at = Some(now() - 1);
        save(&path, &saved).unwrap();
        mode.store(2, Ordering::SeqCst);
        let error = authorize_configs(&mut configs).await.unwrap_err();
        assert!(!error.contains("private_token_value"));
        assert!(read(&path, &url).unwrap().auth_required);
        server.abort();
    }
}

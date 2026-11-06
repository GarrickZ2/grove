//! Several Grove servers working together.
//!
//! The machine a person signs in to connects to their other machines the way
//! any client would: a passkey once, then a revocable device key. Pairing is
//! mutual, so both sides keep a record and either can talk over the one
//! connection the adding side holds open (see [`link`]).

pub mod link;
pub mod proxy;

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicU16, Ordering};
use std::time::Duration;

use serde::Deserialize;
use serde_json::{json, Value};

use crate::api::RemoteAuthorization;
use crate::cli::chat::conn::{device_name, hmac_hex, signed_headers};
use crate::error::{GroveError, Result};
use crate::storage::machines::{self as store, Peer, Profile};

pub const ICONS: [&str; 6] = ["laptop", "desktop", "server", "gpu", "cloud", "home"];
/// Tag on the pairing error that sends a person to a sign-in window.
pub const LOGIN_REQUIRED: &str = "machine_login_required";
const NAME_LIMIT: usize = 60;
const DESCRIPTION_LIMIT: usize = 500;

/// This server's own loopback port, once it is listening.
static HOME_PORT: AtomicU16 = AtomicU16::new(0);

pub(crate) fn home_port() -> u16 {
    HOME_PORT.load(Ordering::Relaxed)
}

fn hostname() -> String {
    std::process::Command::new("hostname")
        .output()
        .ok()
        .and_then(|out| String::from_utf8(out.stdout).ok())
        .map(|name| name.trim().trim_end_matches(".local").to_string())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| "This machine".into())
}

fn fresh_profile() -> Profile {
    Profile {
        id: uuid::Uuid::new_v4().simple().to_string(),
        name: hostname(),
        description: String::new(),
        icon: if cfg!(target_os = "macos") {
            "laptop".into()
        } else {
            "server".into()
        },
    }
}

pub fn this() -> Result<Profile> {
    store::this_or(fresh_profile)
}

/// A partial change to a profile; absent fields stay as they are.
#[derive(Debug, Clone, Default, Deserialize, serde::Serialize)]
pub struct ProfilePatch {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
}

impl ProfilePatch {
    fn apply(&self, profile: &mut Profile) -> Result<()> {
        if let Some(name) = &self.name {
            let name = name.trim();
            if name.is_empty() || name.chars().count() > NAME_LIMIT {
                return Err(GroveError::invalid_data(format!(
                    "A machine name needs 1 to {NAME_LIMIT} characters"
                )));
            }
            profile.name = name.to_string();
        }
        if let Some(description) = &self.description {
            let description = description.trim();
            if description.chars().count() > DESCRIPTION_LIMIT {
                return Err(GroveError::invalid_data(format!(
                    "A machine description can have at most {DESCRIPTION_LIMIT} characters"
                )));
            }
            profile.description = description.to_string();
        }
        if let Some(icon) = &self.icon {
            if !ICONS.contains(&icon.as_str()) {
                return Err(GroveError::invalid_data("Unknown machine icon"));
            }
            profile.icon = icon.clone();
        }
        Ok(())
    }
}

/// Change this machine's profile and tell everyone connected.
pub fn update_this(patch: &ProfilePatch) -> Result<Profile> {
    let mut profile = this()?;
    patch.apply(&mut profile)?;
    store::set_this(profile.clone())?;
    link::announce(&profile);
    Ok(profile)
}

/// Change a machine's profile. A profile belongs to its machine, so another
/// machine's is changed there, and needs it online.
pub fn update(id: &str, patch: &ProfilePatch) -> Result<()> {
    if id == "self" || id == this()?.id {
        update_this(patch)?;
        return Ok(());
    }
    let peer = store::peer(id)?.ok_or_else(|| GroveError::not_found("Machine not found"))?;
    // Reject bad input here, where the person can still see the error.
    patch.apply(&mut peer.profile.clone())?;
    if !link::send(id, link::Frame::SetProfile(patch.clone())) {
        return Err(GroveError::invalid_data(format!(
            "{} is offline",
            peer.profile.name
        )));
    }
    Ok(())
}

/// Everything the machine menu shows. `current` is the machine this window is
/// looking at when that isn't this one.
pub fn overview(current: Option<&str>) -> Result<Value> {
    let this = this()?;
    let machines: Vec<Value> = store::peers()?
        .into_iter()
        .map(|peer| {
            let status = link::status(&peer.profile.id);
            json!({
                "id": peer.profile.id,
                "name": peer.profile.name,
                "description": peer.profile.description,
                "icon": peer.profile.icon,
                "url": peer.url,
                "status": status,
                "version": link::version(&peer.profile.id),
            })
        })
        .collect();
    Ok(json!({
        "current": current.unwrap_or(&this.id),
        "this": this,
        "machines": machines,
    }))
}

/// Whether a loopback proxy can serve the window. Someone reaching this server
/// remotely has no loopback here, and switches through `/machines/{id}/via`.
fn switchable() -> bool {
    home_port() != 0 && !crate::hooks::os_render_disabled()
}

fn normalize_url(url: &str) -> Result<String> {
    let url = url.trim().trim_end_matches('/');
    if url.is_empty() {
        return Err(GroveError::invalid_data("Enter the machine's address"));
    }
    let url = if url.contains("://") {
        url.to_string()
    } else {
        format!("http://{url}")
    };
    let parsed = url::Url::parse(&url)
        .map_err(|_| GroveError::invalid_data("That doesn't look like an address"))?;
    if !matches!(parsed.scheme(), "http" | "https") || parsed.host_str().is_none() {
        return Err(GroveError::invalid_data(
            "An address starts with http:// or https://",
        ));
    }
    Ok(url)
}

fn clean_headers(headers: BTreeMap<String, String>) -> Result<BTreeMap<String, String>> {
    let mut cleaned = BTreeMap::new();
    for (name, value) in headers {
        let (name, value) = (name.trim().to_string(), value.trim().to_string());
        let valid = reqwest::header::HeaderName::from_bytes(name.as_bytes()).is_ok()
            && reqwest::header::HeaderValue::from_str(&value).is_ok();
        if !valid {
            return Err(GroveError::invalid_data(format!(
                "Invalid request header: {name}"
            )));
        }
        cleaned.insert(name, value);
    }
    Ok(cleaned)
}

#[derive(Debug, Deserialize)]
pub struct PairInput {
    pub url: String,
    #[serde(default)]
    pub passkey: String,
    #[serde(default)]
    pub headers: BTreeMap<String, String>,
}

fn pairing_client(headers: &BTreeMap<String, String>) -> Result<reqwest::Client> {
    let mut defaults = reqwest::header::HeaderMap::new();
    for (name, value) in headers {
        if let (Ok(name), Ok(value)) = (
            reqwest::header::HeaderName::from_bytes(name.as_bytes()),
            reqwest::header::HeaderValue::from_str(value),
        ) {
            defaults.insert(name, value);
        }
    }
    reqwest::Client::builder()
        .default_headers(defaults)
        // A redirect here is an access proxy's sign-in page, not Grove.
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| GroveError::storage(e.to_string()))
}

fn unreachable_error(url: &str) -> GroveError {
    GroveError::invalid_data(format!("Can't reach Grove at {url}"))
}

fn login_path(device_id: &str, replacing: Option<&str>) -> String {
    let path = format!("/api/v1/auth/login?device_id={device_id}&trusted=true&cookie=false");
    match replacing {
        Some(previous) => format!("{path}&previous_device_id={previous}"),
        None => path,
    }
}

/// The https address when a server's only objection is plain http.
fn secure_version(url: &str, response: &reqwest::Response) -> Option<String> {
    let location = response.headers().get(reqwest::header::LOCATION)?;
    upgraded(url, location.to_str().ok()?)
}

fn upgraded(url: &str, location: &str) -> Option<String> {
    let from = url::Url::parse(url).ok()?;
    let to = url::Url::parse(location).ok()?;
    (from.scheme() == "http" && to.scheme() == "https" && from.host_str() == to.host_str())
        .then(|| format!("https://{}", to.authority()))
}

async fn login(
    client: &reqwest::Client,
    url: &str,
    passkey: &str,
    replacing: Option<&str>,
) -> Result<(String, String)> {
    if passkey.is_empty() {
        return Err(GroveError::invalid_data("Enter the machine's passkey"));
    }
    let device_id = crate::api::auth::generate_secret_key();
    let path = login_path(&device_id, replacing);
    let mut request = client
        .post(format!("{url}{path}"))
        .json(&json!({ "name": device_name().replace("grove cli", "grove machine") }));
    for (name, value) in signed_headers(passkey, None, "POST", &path) {
        request = request.header(name, value);
    }
    let response = request.send().await.map_err(|_| unreachable_error(url))?;
    if response.status() == reqwest::StatusCode::UNAUTHORIZED {
        return Err(GroveError::invalid_data("Wrong passkey"));
    }
    if !response.status().is_success() {
        return Err(GroveError::invalid_data(format!(
            "{url} refused the sign-in ({})",
            response.status().as_u16()
        )));
    }
    let key = hmac_hex(passkey, &format!("grove-device-key-v1|{device_id}"));
    Ok((device_id, key))
}

/// Connect to another machine: sign in once, keep the device key, stay
/// connected. Connecting to a machine that already connected here keeps one
/// record for the pair.
pub async fn pair(input: PairInput) -> Result<Profile> {
    let mut url = normalize_url(&input.url)?;
    // Connecting again keeps what got through last time, unless replaced.
    let mut headers = store::peers()?
        .into_iter()
        .find(|peer| peer.url.as_deref() == Some(url.as_str()))
        .map(|peer| peer.headers)
        .unwrap_or_default();
    headers.extend(clean_headers(input.headers)?);
    let client = pairing_client(&headers)?;

    let mut info = client
        .get(format!("{url}/api/v1/auth/info"))
        .send()
        .await
        .map_err(|_| unreachable_error(&url))?;
    if let Some(secure) = secure_version(&url, &info) {
        url = secure;
        info = client
            .get(format!("{url}/api/v1/auth/info"))
            .send()
            .await
            .map_err(|_| unreachable_error(&url))?;
    }
    if info.status().is_redirection() {
        return Err(GroveError::storage_tagged(
            LOGIN_REQUIRED,
            "This machine is behind a sign-in page",
        ));
    }
    let required = info
        .json::<Value>()
        .await
        .ok()
        .and_then(|info| info.get("required").and_then(Value::as_bool))
        .ok_or_else(|| unreachable_error(&url))?;

    let (device_id, device_key) = if required {
        // Connecting again replaces the device from last time.
        let previous = store::peers()?
            .into_iter()
            .find(|peer| peer.url.as_deref() == Some(url.as_str()))
            .and_then(|peer| peer.device_id);
        let (id, key) = login(&client, &url, &input.passkey, previous.as_deref()).await?;
        (Some(id), Some(key))
    } else {
        (None, None)
    };

    let path = "/api/v1/machines/self";
    let mut request = client.get(format!("{url}{path}"));
    if let (Some(id), Some(key)) = (&device_id, &device_key) {
        for (name, value) in signed_headers(key, Some(id), "GET", path) {
            request = request.header(name, value);
        }
    }
    let response = request.send().await.map_err(|_| unreachable_error(&url))?;
    if response.status() == reqwest::StatusCode::NOT_FOUND {
        return Err(GroveError::invalid_data(
            "That machine runs an older Grove. Update it first.",
        ));
    }
    let profile: Profile = response.json().await.map_err(|_| unreachable_error(&url))?;
    if profile.id == this()?.id {
        return Err(GroveError::invalid_data("That address is this machine"));
    }

    let proxy_port = store::peer(&profile.id)?.and_then(|peer| peer.proxy_port);
    store::save_peer(Peer {
        url: Some(url),
        device_id,
        device_key,
        proxy_port,
        headers,
        profile: profile.clone(),
    })?;
    // A window on this machine may still be signing with the old key.
    proxy::close(&profile.id).await;
    link::connect(&profile.id);
    Ok(profile)
}

/// A person signed in to whatever is in front of this machine: use that
/// session from now on.
pub async fn refresh_session(id: &str, cookie: &str) -> Result<()> {
    let headers = clean_headers(BTreeMap::from([("Cookie".to_string(), cookie.to_string())]))?;
    if !store::update_peer(id, |peer| peer.headers.extend(headers))? {
        return Err(GroveError::not_found("Machine not found"));
    }
    proxy::close(id).await;
    link::connect(id);
    Ok(())
}

/// Unpair. The other side forgets this machine too when it hears about it.
pub async fn remove(id: &str) -> Result<()> {
    let delivered = link::send(id, link::Frame::Unpair);
    if !forget(id)? {
        return Err(GroveError::not_found("Machine not found"));
    }
    if !delivered {
        link::disconnect(id);
    }
    proxy::close(id).await;
    Ok(())
}

/// Drop a pair's record here and stop trusting the device it used.
fn forget(id: &str) -> Result<bool> {
    let Some(peer) = store::remove_peer(id)? else {
        return Ok(false);
    };
    if let (None, Some(device)) = (&peer.url, &peer.device_id) {
        let devices = crate::storage::auth_devices::list_all()?;
        for (scope, record) in devices {
            if &record.id == device {
                crate::storage::auth_devices::revoke_browser(&scope, record.browser_id())?;
            }
        }
    }
    Ok(true)
}

/// How to sign requests to a peer; `None` for a server without a passkey.
pub(crate) fn authorization(peer: &Peer) -> Option<RemoteAuthorization> {
    Some(RemoteAuthorization {
        signing_key: peer.device_key.clone()?,
        device_id: peer.device_id.clone(),
    })
}

/// Start the connections this machine holds. Call once when the server starts.
pub fn start(port: u16) {
    HOME_PORT.store(port, Ordering::Relaxed);
    match store::peers() {
        Ok(peers) => {
            for peer in peers.iter().filter(|peer| peer.url.is_some()) {
                link::connect(&peer.profile.id);
            }
        }
        Err(error) => eprintln!("[Grove] could not read paired machines: {error}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn addresses_are_normalized_and_checked() {
        assert_eq!(
            normalize_url(" devbox:3900/ ").unwrap(),
            "http://devbox:3900"
        );
        assert_eq!(
            normalize_url("https://grove.example.com").unwrap(),
            "https://grove.example.com"
        );
        assert!(normalize_url("").is_err());
        assert!(normalize_url("ftp://devbox").is_err());
    }

    #[test]
    fn only_a_same_host_https_redirect_is_an_upgrade() {
        assert_eq!(
            upgraded(
                "http://grove.example.com",
                "https://grove.example.com/api/v1/auth/info"
            ),
            Some("https://grove.example.com".to_string())
        );
        assert_eq!(
            upgraded("http://grove.example.com", "https://team.example.com/login"),
            None
        );
        assert_eq!(
            upgraded("https://grove.example.com", "https://grove.example.com/x"),
            None
        );
    }

    #[test]
    fn connecting_again_names_the_device_it_replaces() {
        assert!(!login_path("new", None).contains("previous_device_id"));
        assert!(login_path("new", Some("old")).ends_with("&previous_device_id=old"));
    }

    #[test]
    fn profile_changes_are_validated_before_applying() {
        let mut profile = fresh_profile();
        let original = profile.clone();
        let blank = ProfilePatch {
            name: Some("  ".into()),
            ..Default::default()
        };
        assert!(blank.apply(&mut profile).is_err());
        let unknown = ProfilePatch {
            icon: Some("rocket".into()),
            ..Default::default()
        };
        assert!(unknown.apply(&mut profile).is_err());
        assert_eq!(profile, original);

        let good = ProfilePatch {
            name: Some(" GPU box ".into()),
            description: Some(" Runs evals ".into()),
            icon: Some("gpu".into()),
        };
        good.apply(&mut profile).unwrap();
        assert_eq!(profile.name, "GPU box");
        assert_eq!(profile.description, "Runs evals");
        assert_eq!(profile.icon, "gpu");
    }

    #[test]
    fn bad_request_headers_are_refused() {
        let good = BTreeMap::from([(" CF-Access-Client-Id ".to_string(), " abc ".to_string())]);
        assert_eq!(
            clean_headers(good).unwrap().get("CF-Access-Client-Id"),
            Some(&"abc".to_string())
        );
        let bad = BTreeMap::from([("bad name".to_string(), "x".to_string())]);
        assert!(clean_headers(bad).is_err());
    }
}

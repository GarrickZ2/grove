//! Telegram Bot API wire layer. The bot token is part of every URL, so no
//! error produced here may include a request URL.
use serde_json::{json, Value};
use std::time::Duration;

const BASE: &str = "https://api.telegram.org";
/// Bot API `getFile` refuses larger downloads.
pub const MAX_DOWNLOAD: u64 = 20 * 1024 * 1024;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("Telegram rejected the bot token; connect the bot again")]
    Unauthorized,
    #[error("Another program is already receiving updates for this Telegram bot. Stop it (or remove its webhook) and reconnect.")]
    Conflict,
    #[error("Telegram rate limit; retry after {0}s")]
    RateLimited(u64),
    #[error("Telegram rejected the request: {0}")]
    Rejected(String),
    #[error("{0}")]
    Transport(String),
}

#[derive(Clone)]
pub struct Api {
    client: reqwest::Client,
    token: String,
}

pub fn valid_token(token: &str) -> bool {
    let Some((id, secret)) = token.split_once(':') else {
        return false;
    };
    !id.is_empty()
        && id.bytes().all(|byte| byte.is_ascii_digit())
        && secret.len() >= 30
        && secret
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

impl Api {
    pub fn new(token: &str) -> Result<Self, String> {
        if !valid_token(token) {
            return Err("Invalid Telegram bot token".into());
        }
        Ok(Self {
            client: reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .map_err(|_| "Could not initialize Telegram HTTP client".to_owned())?,
            token: token.into(),
        })
    }

    /// Calls a Bot API method. `timeout` must exceed any long-poll timeout
    /// carried in `body`.
    pub async fn call(&self, method: &str, body: Value, timeout: Duration) -> Result<Value, Error> {
        let response = self
            .client
            .post(format!("{BASE}/bot{}/{method}", self.token))
            .timeout(timeout)
            .json(&body)
            .send()
            .await
            .map_err(transport)?;
        let status = response.status();
        let value: Value = response.json().await.map_err(transport)?;
        if value["ok"].as_bool() == Some(true) {
            return Ok(value["result"].clone());
        }
        let description = value["description"]
            .as_str()
            .unwrap_or("unknown error")
            .to_owned();
        Err(
            match value["error_code"]
                .as_u64()
                .unwrap_or(status.as_u16().into())
            {
                401 | 404 => Error::Unauthorized,
                409 => Error::Conflict,
                429 => Error::RateLimited(
                    value["parameters"]["retry_after"]
                        .as_u64()
                        .unwrap_or(1)
                        .clamp(1, 60),
                ),
                _ => Error::Rejected(description),
            },
        )
    }

    /// Sends once more after a 429; Telegram guarantees nothing was sent.
    pub async fn call_retrying(
        &self,
        method: &str,
        body: Value,
        timeout: Duration,
    ) -> Result<Value, Error> {
        match self.call(method, body.clone(), timeout).await {
            Err(Error::RateLimited(seconds)) => {
                tokio::time::sleep(Duration::from_secs(seconds)).await;
                self.call(method, body, timeout).await
            }
            result => result,
        }
    }

    pub async fn download(&self, file_id: &str) -> Result<Vec<u8>, Error> {
        let file = self
            .call(
                "getFile",
                json!({"file_id": file_id}),
                Duration::from_secs(15),
            )
            .await?;
        if file["file_size"].as_u64().unwrap_or(0) > MAX_DOWNLOAD {
            return Err(Error::Rejected("file is too large".into()));
        }
        let path = file["file_path"]
            .as_str()
            .filter(|path| !path.is_empty() && !path.contains(".."))
            .ok_or_else(|| Error::Rejected("file is unavailable".into()))?;
        let response = self
            .client
            .get(format!("{BASE}/file/bot{}/{path}", self.token))
            .timeout(Duration::from_secs(60))
            .send()
            .await
            .map_err(transport)?;
        if !response.status().is_success() {
            return Err(Error::Rejected(format!(
                "file download failed ({})",
                response.status().as_u16()
            )));
        }
        let bytes = response.bytes().await.map_err(transport)?;
        if bytes.len() as u64 > MAX_DOWNLOAD {
            return Err(Error::Rejected("file is too large".into()));
        }
        Ok(bytes.to_vec())
    }
}

fn transport(error: reqwest::Error) -> Error {
    if error.is_timeout() {
        return Error::Transport("Telegram request timed out".into());
    }
    // reqwest includes the URL (and therefore the token) by default.
    Error::Transport(format!("Telegram request failed: {}", error.without_url()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_shape_is_checked_before_it_reaches_a_url() {
        assert!(valid_token("123456:ABCdefGHIjklMNOpqrSTUvwxYZ0123456789"));
        assert!(!valid_token("123456"));
        assert!(!valid_token("abc:ABCdefGHIjklMNOpqrSTUvwxYZ0123456789"));
        assert!(!valid_token("123:ABCdefGHIjklMNOpqrSTUvwxYZ01234/../x"));
        assert!(Api::new("bad").is_err());
    }
}

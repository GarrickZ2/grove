//! Slack Web API and Socket Mode wire layer. Socket Mode keeps Grove off the
//! public internet: Slack pushes events over an outbound WebSocket.
use futures::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::time::Duration;
use tokio_tungstenite::tungstenite::Message;

const BASE: &str = "https://slack.com/api";
pub const MAX_DOWNLOAD: u64 = 20 * 1024 * 1024;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("Slack rejected the token ({0}); connect Slack again")]
    Unauthorized(String),
    #[error("Slack rate limit; retry after {0}s")]
    RateLimited(u64),
    #[error("Slack rejected the request: {0}")]
    Rejected(String),
    #[error("{0}")]
    Transport(String),
}

pub fn valid_bot_token(token: &str) -> bool {
    token.starts_with("xoxb-") && token.len() > 20 && !token.contains(char::is_whitespace)
}
pub fn valid_app_token(token: &str) -> bool {
    token.starts_with("xapp-") && token.len() > 20 && !token.contains(char::is_whitespace)
}

#[derive(Clone)]
pub struct Api {
    client: reqwest::Client,
    token: String,
}

fn transport(error: reqwest::Error) -> Error {
    if error.is_timeout() {
        return Error::Transport("Slack request timed out".into());
    }
    Error::Transport(format!("Slack request failed: {}", error.without_url()))
}

impl Api {
    pub fn new(token: &str) -> Result<Self, String> {
        if !valid_bot_token(token) && !valid_app_token(token) {
            return Err("Invalid Slack token".into());
        }
        Ok(Self {
            client: reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .map_err(|_| "Could not initialize Slack HTTP client".to_owned())?,
            token: token.into(),
        })
    }

    /// Form-encoded call; works for every Web API method. Nested values (for
    /// example `blocks`) are passed as JSON strings.
    pub async fn call(&self, method: &str, params: &[(&str, String)]) -> Result<Value, Error> {
        let response = self
            .client
            .post(format!("{BASE}/{method}"))
            .bearer_auth(&self.token)
            .timeout(Duration::from_secs(20))
            .form(params)
            .send()
            .await
            .map_err(transport)?;
        if response.status().as_u16() == 429 {
            let seconds = response
                .headers()
                .get("retry-after")
                .and_then(|value| value.to_str().ok())
                .and_then(|value| value.parse().ok())
                .unwrap_or(1u64);
            return Err(Error::RateLimited(seconds.clamp(1, 60)));
        }
        let value: Value = response.json().await.map_err(transport)?;
        if value["ok"].as_bool() == Some(true) {
            return Ok(value);
        }
        let error = value["error"]
            .as_str()
            .unwrap_or("unknown_error")
            .to_owned();
        Err(match error.as_str() {
            "invalid_auth" | "not_authed" | "account_inactive" | "token_revoked"
            | "token_expired" => Error::Unauthorized(error),
            _ => Error::Rejected(error),
        })
    }

    /// Retries once after a 429; Slack guarantees nothing was posted.
    pub async fn call_retrying(
        &self,
        method: &str,
        params: &[(&str, String)],
    ) -> Result<Value, Error> {
        match self.call(method, params).await {
            Err(Error::RateLimited(seconds)) => {
                tokio::time::sleep(Duration::from_secs(seconds)).await;
                self.call(method, params).await
            }
            result => result,
        }
    }

    /// Downloads a private file. The bot token is only ever sent to Slack's
    /// own file host.
    pub async fn download(&self, url: &str) -> Result<Vec<u8>, Error> {
        let parsed =
            url::Url::parse(url).map_err(|_| Error::Rejected("invalid file URL".into()))?;
        if parsed.scheme() != "https" || parsed.host_str() != Some("files.slack.com") {
            return Err(Error::Rejected("unexpected file host".into()));
        }
        let response = self
            .client
            .get(parsed)
            .bearer_auth(&self.token)
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
        if response.content_length().unwrap_or(0) > MAX_DOWNLOAD {
            return Err(Error::Rejected("file is too large".into()));
        }
        let bytes = response.bytes().await.map_err(transport)?;
        if bytes.len() as u64 > MAX_DOWNLOAD {
            return Err(Error::Rejected("file is too large".into()));
        }
        Ok(bytes.to_vec())
    }
}

/// One Socket Mode envelope, already acknowledged.
pub struct Envelope {
    pub kind: String,
    pub payload: Value,
}

pub struct Socket {
    stream: tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
}

impl Socket {
    pub async fn open(app: &Api) -> Result<Self, Error> {
        let result = app.call("apps.connections.open", &[]).await?;
        let url = result["url"]
            .as_str()
            .filter(|url| url.starts_with("wss://"))
            .ok_or_else(|| Error::Rejected("no Socket Mode URL".into()))?;
        let _ = rustls::crypto::ring::default_provider().install_default();
        let (stream, _) = tokio::time::timeout(
            Duration::from_secs(20),
            tokio_tungstenite::connect_async(url),
        )
        .await
        .map_err(|_| Error::Transport("Slack Socket Mode connection timed out".into()))?
        // The URL carries a ticket; keep it out of errors.
        .map_err(|_| Error::Transport("Could not open Slack Socket Mode connection".into()))?;
        Ok(Self { stream })
    }

    /// Next event envelope. Returns `Ok(None)` when Slack asks the client to
    /// reconnect or closes the socket.
    pub async fn next(&mut self) -> Result<Option<Envelope>, Error> {
        loop {
            // Slack pings every few seconds; silence means a dead socket.
            let frame = tokio::time::timeout(Duration::from_secs(90), self.stream.next())
                .await
                .map_err(|_| Error::Transport("Slack Socket Mode connection went silent".into()))?;
            let Some(frame) = frame else {
                return Ok(None);
            };
            let frame = frame
                .map_err(|_| Error::Transport("Slack Socket Mode connection dropped".into()))?;
            let text = match frame {
                Message::Text(text) => text,
                Message::Ping(data) => {
                    let _ = self.stream.send(Message::Pong(data)).await;
                    continue;
                }
                Message::Close(_) => return Ok(None),
                _ => continue,
            };
            let Ok(value) = serde_json::from_str::<Value>(&text) else {
                continue;
            };
            let kind = value["type"].as_str().unwrap_or_default().to_owned();
            if let Some(envelope_id) = value["envelope_id"].as_str() {
                // Ack before any work: Slack retries after 3 seconds.
                let ack = json!({"envelope_id": envelope_id}).to_string();
                self.stream
                    .send(Message::Text(ack.into()))
                    .await
                    .map_err(|_| Error::Transport("Could not acknowledge Slack event".into()))?;
            }
            match kind.as_str() {
                "disconnect" => return Ok(None),
                "events_api" | "interactive" | "slash_commands" => {
                    return Ok(Some(Envelope {
                        kind,
                        payload: value["payload"].clone(),
                    }))
                }
                _ => {}
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_kinds_are_distinguished() {
        assert!(valid_bot_token("xoxb-1234567890-abcdefghij"));
        assert!(!valid_bot_token("xapp-1-A123-456-abcdefghij"));
        assert!(valid_app_token("xapp-1-A123-456-abcdefghij"));
        assert!(!valid_app_token("xapp-1 A123"));
        assert!(Api::new("nope").is_err());
    }

    #[tokio::test]
    async fn file_downloads_never_leave_slack_file_hosts() {
        let api = Api::new("xoxb-1234567890-abcdefghij").unwrap();
        for url in [
            "https://evil.example/file",
            "http://files.slack.com/x",
            "https://files.slack.com.evil.example/x",
        ] {
            assert!(matches!(api.download(url).await, Err(Error::Rejected(_))));
        }
    }
}

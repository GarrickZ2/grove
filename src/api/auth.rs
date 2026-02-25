//! Authentication module for Grove mobile access
//!
//! Supports two modes:
//! - **No auth** (`grove web`): all requests pass through
//! - **HMAC-SHA256** (`grove mobile`): every request must carry a valid signature;
//!   the secret key never travels over the wire

use axum::{
    body::Body,
    extract::{Json, Request},
    http::StatusCode,
    middleware::Next,
    response::{IntoResponse, Response},
};
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

type HmacSha256 = Hmac<Sha256>;

/// Label exposed to the frontend via `/auth/info`.
#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum AuthMode {
    None,
    Hmac,
}

/// Server authentication state.
pub struct ServerAuth {
    pub mode: AuthMode,
    /// `None` ⇒ no auth required.  `Some(sk)` ⇒ HMAC mode.
    pub secret_key: Option<String>,
    /// Nonce replay-prevention map: nonce → timestamp (epoch secs).
    used_nonces: Mutex<HashMap<String, i64>>,
}

impl ServerAuth {
    /// No authentication (localhost / `grove web`).
    pub fn no_auth() -> Self {
        Self {
            mode: AuthMode::None,
            secret_key: None,
            used_nonces: Mutex::new(HashMap::new()),
        }
    }

    /// HMAC-SHA256 authentication (`grove mobile`).
    pub fn hmac(secret_key: String) -> Self {
        Self {
            mode: AuthMode::Hmac,
            secret_key: Some(secret_key),
            used_nonces: Mutex::new(HashMap::new()),
        }
    }

    /// Verify an HMAC-SHA256 signature.
    ///
    /// The message is `"{timestamp}|{nonce}|{METHOD}|{path}"`.
    pub fn verify_signature(
        &self,
        timestamp: &str,
        nonce: &str,
        method: &str,
        path: &str,
        signature: &str,
    ) -> bool {
        let sk = match &self.secret_key {
            Some(sk) => sk,
            None => return true, // no auth mode
        };

        // 1. Timestamp window check (±60 s)
        let ts: i64 = match timestamp.parse() {
            Ok(v) => v,
            Err(_) => return false,
        };
        let now = chrono::Utc::now().timestamp();
        if (now - ts).abs() > 60 {
            return false;
        }

        // 2. Nonce replay check
        {
            let mut nonces = self.used_nonces.lock().unwrap();

            if nonces.contains_key(nonce) {
                return false; // replay
            }

            // Record this nonce
            nonces.insert(nonce.to_string(), ts);

            // Purge stale nonces (> 120 s old)
            nonces.retain(|_, &mut t| (now - t).abs() <= 120);
        }

        // 3. Compute expected HMAC
        let message = format!("{}|{}|{}|{}", timestamp, nonce, method, path);
        let mut mac =
            HmacSha256::new_from_slice(sk.as_bytes()).expect("HMAC accepts any key length");
        mac.update(message.as_bytes());
        let expected = hex::encode(mac.finalize().into_bytes());

        // Constant-time-ish comparison (hex strings, both lowercase)
        expected == signature
    }
}

/// Generate a cryptographically random 64-character hex secret key.
pub fn generate_secret_key() -> String {
    let mut bytes = [0u8; 32];
    getrandom::getrandom(&mut bytes).expect("Failed to generate random bytes");
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

// ─── Middleware ──────────────────────────────────────────────────────────────

/// Extract a single value from a query string: `key=value&…`
fn query_param<'a>(query: &'a str, key: &str) -> Option<&'a str> {
    for part in query.split('&') {
        if let Some(value) = part
            .strip_prefix(key)
            .and_then(|rest| rest.strip_prefix('='))
        {
            if !value.is_empty() {
                return Some(value);
            }
        }
    }
    None
}

/// Axum middleware — checks HMAC signature (headers or query params).
///
/// Uses `OriginalUri` so that the path seen here is the full request path
/// (e.g. `/api/v1/projects`) even when the middleware runs inside a `.nest()`.
pub async fn auth_middleware(
    axum::extract::State(auth): axum::extract::State<Arc<ServerAuth>>,
    original_uri: axum::extract::OriginalUri,
    request: Request<Body>,
    next: Next,
) -> Response {
    // No-auth mode → pass through
    if auth.secret_key.is_none() {
        return next.run(request).await;
    }

    let method = request.method().as_str().to_uppercase();
    // Use the original (un-stripped) URI so the path matches what the client signed.
    let path = original_uri.path().to_string();

    // Try headers first
    let from_headers = (|| {
        let ts = request.headers().get("x-timestamp")?.to_str().ok()?;
        let nonce = request.headers().get("x-nonce")?.to_str().ok()?;
        let sig = request.headers().get("x-signature")?.to_str().ok()?;
        Some((ts.to_string(), nonce.to_string(), sig.to_string()))
    })();

    if let Some((ts, nonce, sig)) = from_headers {
        if auth.verify_signature(&ts, &nonce, &method, &path, &sig) {
            return next.run(request).await;
        }
        return (StatusCode::UNAUTHORIZED, "Invalid signature").into_response();
    }

    // Fallback: query params (WebSocket upgrade)
    if let Some(query) = original_uri.query() {
        if let (Some(ts), Some(nonce), Some(sig)) = (
            query_param(query, "ts"),
            query_param(query, "nonce"),
            query_param(query, "sig"),
        ) {
            if auth.verify_signature(ts, nonce, &method, &path, sig) {
                return next.run(request).await;
            }
            return (StatusCode::UNAUTHORIZED, "Invalid signature").into_response();
        }
    }

    (StatusCode::UNAUTHORIZED, "Unauthorized").into_response()
}

// ─── Public endpoints (not behind middleware) ────────────────────────────────

#[derive(Serialize)]
pub struct AuthInfoResponse {
    pub required: bool,
    pub mode: AuthMode,
}

/// `GET /api/v1/auth/info` — tells the SPA whether auth is required and which mode.
pub async fn auth_info(
    axum::extract::State(auth): axum::extract::State<Arc<ServerAuth>>,
) -> Json<AuthInfoResponse> {
    Json(AuthInfoResponse {
        required: auth.secret_key.is_some(),
        mode: auth.mode,
    })
}

#[derive(Deserialize)]
pub struct VerifyRequest {
    pub proof: String,
}

#[derive(Serialize)]
pub struct VerifyResponse {
    pub valid: bool,
}

/// `POST /api/v1/auth/verify` — client sends `HMAC(SK, "grove-verify")` as proof.
pub async fn auth_verify(
    axum::extract::State(auth): axum::extract::State<Arc<ServerAuth>>,
    Json(req): Json<VerifyRequest>,
) -> Result<Json<VerifyResponse>, StatusCode> {
    match &auth.secret_key {
        None => Ok(Json(VerifyResponse { valid: true })),
        Some(sk) => {
            let mut mac =
                HmacSha256::new_from_slice(sk.as_bytes()).expect("HMAC accepts any key length");
            mac.update(b"grove-verify");
            let expected = hex::encode(mac.finalize().into_bytes());

            if req.proof == expected {
                Ok(Json(VerifyResponse { valid: true }))
            } else {
                Err(StatusCode::UNAUTHORIZED)
            }
        }
    }
}

//! CSRF / cross-origin request guard for the Grove API.
//!
//! `grove web` runs unauthenticated on `127.0.0.1`; without this guard, any
//! webpage in the user's browser can POST to the API (the browser attaches no
//! credentials, but every endpoint here is unauthenticated, so that's enough
//! to e.g. trigger `git clone`). HMAC mode (`grove mobile`) doesn't *need*
//! this — a missing/forged signature already fails — but the check is cheap
//! and harmless to leave on for defense in depth.
//!
//! Policy for non-safe methods (POST/PUT/PATCH/DELETE):
//!  1. If `Sec-Fetch-Site` is present (all evergreen browsers send it),
//!     accept only `same-origin` or `none`. `cross-site` and `same-site`
//!     (= different subdomain on same eTLD+1) are rejected.
//!  2. Else if `Origin` is present, host must match the request `Host`.
//!  3. Else if `Referer` is present, host must match the request `Host`.
//!  4. Else allow — likely a non-browser client (curl, mobile native code).
//!     Browsers always send at least one of the above for non-safe methods.

use axum::{
    body::Body,
    extract::Request,
    http::{header, Method, StatusCode},
    middleware::Next,
    response::{IntoResponse, Response},
};

fn is_safe_method(method: &Method) -> bool {
    matches!(*method, Method::GET | Method::HEAD | Method::OPTIONS)
}

fn header_str(req: &Request<Body>, name: header::HeaderName) -> Option<&str> {
    req.headers().get(name).and_then(|v| v.to_str().ok())
}

/// Compare the host portion of `url_or_origin` to the request `Host` header.
/// Both forms are accepted: bare `Host: example:3001` and full origin
/// `Origin: http://example:3001`.
fn host_matches(value: &str, host_header: &str) -> bool {
    // Strip scheme.
    let without_scheme = value
        .split_once("://")
        .map(|(_, rest)| rest)
        .unwrap_or(value);
    // Strip path.
    let host_part = without_scheme.split('/').next().unwrap_or("");
    host_part.eq_ignore_ascii_case(host_header)
}

pub async fn csrf_middleware(request: Request<Body>, next: Next) -> Response {
    if is_safe_method(request.method()) {
        return next.run(request).await;
    }

    // Sec-Fetch-Site is the strongest signal — modern browsers always send it.
    if let Some(site) = header_str(&request, header::HeaderName::from_static("sec-fetch-site")) {
        return match site {
            "same-origin" | "none" => next.run(request).await,
            _ => (StatusCode::FORBIDDEN, "Cross-origin request blocked").into_response(),
        };
    }

    let host = match header_str(&request, header::HOST) {
        Some(h) => h.to_string(),
        None => return next.run(request).await,
    };

    if let Some(origin) = header_str(&request, header::ORIGIN) {
        return if host_matches(origin, &host) {
            next.run(request).await
        } else {
            (StatusCode::FORBIDDEN, "Cross-origin request blocked").into_response()
        };
    }

    if let Some(referer) = header_str(&request, header::REFERER) {
        return if host_matches(referer, &host) {
            next.run(request).await
        } else {
            (StatusCode::FORBIDDEN, "Cross-origin request blocked").into_response()
        };
    }

    // No Sec-Fetch-Site, no Origin, no Referer — almost certainly a
    // non-browser client. Browsers attach at least one for non-safe methods.
    next.run(request).await
}

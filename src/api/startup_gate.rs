//! The GUI's server before the backend is ready.
//!
//! The desktop window opens at once, while the backend is still getting ready
//! (first-run setup can take a while). Until then this serves only what the
//! launch window needs: its static files and `/api/v1/startup`.
//!
//! Nothing is kept waiting: a request held open until the backend is ready
//! would fail once the webview gave up on it. A page asked for early (the
//! hidden main window, the tray's) gets a blank page that follows the startup
//! status and loads the real one when the backend is ready.

use std::sync::{Arc, OnceLock};

use axum::body::Body;
use axum::extract::{Request, State};
use axum::http::{header, StatusCode};
use axum::response::{Html, IntoResponse, Response};
use axum::{Json, Router};
use tower::ServiceExt;

const STARTUP_PATH: &str = "/api/v1/startup";

/// Shown (in windows that are still hidden) in place of a page asked for
/// before the backend is ready. It reloads into that page once it is.
const WAITING_PAGE: &str = r#"<!doctype html>
<meta charset="utf-8">
<title>Grove</title>
<style>html{background:#fafafa}@media (prefers-color-scheme:dark){html{background:#0a0a0b}}</style>
<script>
(async function wait() {
  try {
    const status = await (await fetch("/api/v1/startup", { cache: "no-store" })).json();
    if (status.ready) return location.reload();
  } catch (error) { /* the server is still coming up */ }
  setTimeout(wait, 200);
})();
</script>
"#;

#[derive(Clone, Default)]
pub struct StartupGate {
    router: Arc<OnceLock<Router>>,
}

impl StartupGate {
    /// The backend is ready: requests go to `router` from now on.
    pub fn open(&self, router: Router) {
        let _ = self.router.set(router);
    }

    pub fn router(&self) -> Router {
        Router::new().fallback(handle).with_state(self.clone())
    }
}

/// A file the launch window may load before the backend is ready. The app's
/// own page is not one: it would start calling the API.
fn is_launch_file(path: &str) -> bool {
    !path.starts_with("/api/")
        && path != "/index.html"
        && path
            .rsplit('/')
            .next()
            .is_some_and(|name| name.contains('.'))
}

async fn handle(State(gate): State<StartupGate>, request: Request) -> Response {
    let path = request.uri().path();
    if path == STARTUP_PATH {
        return Json(crate::startup::status()).into_response();
    }
    if let Some(router) = gate.router.get() {
        return match router.clone().oneshot(request).await {
            Ok(response) => response,
            Err(never) => match never {},
        };
    }
    if is_launch_file(path) {
        return super::serve_embedded(request.uri().clone())
            .await
            .into_response();
    }
    if path.starts_with("/api/") {
        return Response::builder()
            .status(StatusCode::SERVICE_UNAVAILABLE)
            .body(Body::from("Grove is still starting"))
            .expect("build 503 response");
    }
    ([(header::CACHE_CONTROL, "no-store")], Html(WAITING_PAGE)).into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::routing::get;

    #[test]
    fn only_static_files_are_served_before_the_backend_is_ready() {
        assert!(is_launch_file("/launch.html"));
        assert!(is_launch_file("/assets/launch-abc123.js"));
        assert!(is_launch_file("/favicon.svg"));
        assert!(!is_launch_file("/"));
        assert!(!is_launch_file("/index.html"));
        assert!(!is_launch_file("/api/v1/config"));
        assert!(!is_launch_file("/api/v1/files/a.txt"));
        assert!(!is_launch_file("/tasks/123"));
    }

    async fn ask(gate: &StartupGate, path: &str) -> (StatusCode, String) {
        let request = Request::builder().uri(path).body(Body::empty()).unwrap();
        // A request kept waiting would never come back here: the gate is not opened meanwhile.
        let response = tokio::time::timeout(
            std::time::Duration::from_secs(2),
            gate.router().oneshot(request),
        )
        .await
        .expect("answered at once")
        .unwrap();
        let status = response.status();
        let body = axum::body::to_bytes(response.into_body(), 1 << 20)
            .await
            .unwrap();
        (status, String::from_utf8_lossy(&body).into_owned())
    }

    #[tokio::test]
    async fn nothing_is_kept_waiting_before_the_backend_is_ready() {
        let gate = StartupGate::default();
        for page in ["/", "/index.html", "/tasks/123"] {
            let (status, body) = ask(&gate, page).await;
            assert_eq!(status, StatusCode::OK, "{page}");
            assert!(
                body.contains(STARTUP_PATH),
                "{page} follows the startup status"
            );
        }
        let (status, _) = ask(&gate, "/api/v1/config").await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
        let (status, body) = ask(&gate, STARTUP_PATH).await;
        assert_eq!(status, StatusCode::OK);
        assert!(body.contains("\"ready\""));
    }

    #[tokio::test]
    async fn the_real_router_answers_once_the_backend_is_ready() {
        let gate = StartupGate::default();
        gate.open(
            Router::new()
                .route("/", get(|| async { "the app" }))
                .route("/api/v1/config", get(|| async { "config" })),
        );
        assert_eq!(ask(&gate, "/").await.1, "the app");
        assert_eq!(ask(&gate, "/api/v1/config").await.1, "config");
    }
}

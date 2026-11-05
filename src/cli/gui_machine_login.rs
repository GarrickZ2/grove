//! Signing in to whatever stands in front of a machine.
//!
//! An access proxy answers a machine with a redirect to its sign-in page, and
//! only a person can get through that (a one-time code, MFA). So the person
//! does, in a window that follows the redirects, and Grove keeps the cookies
//! the site ended up with. Nothing here knows which proxy that was.

use std::sync::Mutex;
use std::time::Duration;

use tauri::webview::PageLoadEvent;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use tokio::sync::mpsc;

const LABEL: &str = "machine-login";
/// Long enough to find a phone, not forever.
const PATIENCE: Duration = Duration::from_secs(600);

enum Outcome {
    Arrived,
    Closed,
}

fn same_host(a: &url::Url, b: &url::Url) -> bool {
    a.host_str() == b.host_str()
}

fn cookie_header<'a>(cookies: impl Iterator<Item = (&'a str, &'a str)>) -> String {
    cookies
        .map(|(name, value)| format!("{name}={value}"))
        .collect::<Vec<_>>()
        .join("; ")
}

/// Open the machine's address and wait until a page of its own has loaded,
/// which means the sign-in is behind us. Returns a `Cookie` header value.
///
/// Async, so reading cookies doesn't block the thread the webview runs on.
#[tauri::command]
pub async fn machine_login(app: AppHandle, url: String) -> Result<String, String> {
    let target: url::Url = url.parse().map_err(|_| "Invalid address".to_string())?;
    if let Some(previous) = app.get_webview_window(LABEL) {
        let _ = previous.destroy();
    }

    let (arrived, mut outcome) = mpsc::unbounded_channel();
    let on_load = arrived.clone();
    let destination = target.clone();
    // Sends once a page of the target has finished; redirects never finish.
    let window = WebviewWindowBuilder::new(&app, LABEL, WebviewUrl::External(target.clone()))
        .title(format!(
            "Sign in to {}",
            target.host_str().unwrap_or_default()
        ))
        .inner_size(480.0, 720.0)
        .center()
        .on_page_load(move |_, payload| {
            if payload.event() == PageLoadEvent::Finished && same_host(payload.url(), &destination)
            {
                let _ = on_load.send(Outcome::Arrived);
            }
        })
        .build()
        .map_err(|error| error.to_string())?;
    let closed = Mutex::new(Some(arrived));
    window.on_window_event(move |event| {
        if matches!(event, WindowEvent::Destroyed) {
            if let Some(sender) = closed.lock().ok().and_then(|mut slot| slot.take()) {
                let _ = sender.send(Outcome::Closed);
            }
        }
    });

    let waited = tokio::time::timeout(PATIENCE, outcome.recv()).await;
    let result = match waited {
        Ok(Some(Outcome::Arrived)) => window
            .cookies_for_url(target)
            .map_err(|error| error.to_string())
            .and_then(|cookies| {
                let header = cookie_header(cookies.iter().map(|c| (c.name(), c.value())));
                if header.is_empty() {
                    Err("The sign-in left nothing to connect with".to_string())
                } else {
                    Ok(header)
                }
            }),
        Ok(_) => Err("Sign-in was closed".to_string()),
        Err(_) => Err("Sign-in timed out".to_string()),
    };
    let _ = window.destroy();
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cookies_become_one_header() {
        let cookies = [("CF_Authorization", "jwt"), ("session", "1")];
        assert_eq!(
            cookie_header(cookies.into_iter()),
            "CF_Authorization=jwt; session=1"
        );
    }

    #[test]
    fn only_the_machines_own_host_counts_as_arrival() {
        let target: url::Url = "https://grove.example.com".parse().unwrap();
        let sign_in: url::Url = "https://team.example.com/login".parse().unwrap();
        let page: url::Url = "https://grove.example.com/x".parse().unwrap();
        assert!(!same_host(&sign_in, &target));
        assert!(same_host(&page, &target));
    }
}

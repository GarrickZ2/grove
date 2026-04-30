//! macOS-first menubar tray for Grove.
//!
//! Pure click-driven popover: tray icon click → toggle the list popover.
//! No auto-popup, no toast, no transparency tricks. The popover is a
//! standard rectangular webview window that React paints inside. All
//! "Open" actions just bring the main Grove window to the foreground —
//! no deep-linking, no cross-window navigation events.

use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{
    image::Image,
    menu::{Menu, MenuEvent, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder,
};

/// Wire schema for `tray:navigate` events and the pending-navigate stash.
/// Typed (rather than raw JSON Value) so schema drift between Rust and
/// React side surfaces at compile time on the Rust side.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NavigatePayload {
    route: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    project_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    task_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    chat_id: Option<String>,
}

struct PendingEntry {
    payload: NavigatePayload,
    stashed_at_ms: i64,
}

/// Last `tray:navigate` payload, kept in case the main window's listener
/// wasn't registered yet when the event fired (the listen() call resolves
/// asynchronously). The frontend calls `tray_take_pending_navigate` on
/// mount to replay any missed navigation. TTL prevents a future re-mount
/// (e.g. theme switch causing AppContent churn) from silently replaying
/// a stale Open click hours later.
static PENDING_NAVIGATE: Mutex<Option<PendingEntry>> = Mutex::new(None);

/// 5 minutes — generous enough to cover cold-start delays (auth gate,
/// React mount under heavy CPU load) while still preventing replay of
/// hours-old clicks after a long suspend / late re-mount.
const PENDING_NAVIGATE_TTL_MS: i64 = 300_000;

fn record_navigate(payload: NavigatePayload) {
    if let Ok(mut slot) = PENDING_NAVIGATE.lock() {
        *slot = Some(PendingEntry {
            payload,
            stashed_at_ms: chrono::Utc::now().timestamp_millis(),
        });
    }
}

const TRAY_ICON_BYTES: &[u8] = include_bytes!("../../src-tauri/icons/32x32.png");
const POPOVER_LABEL: &str = "tray-popover";
const POPOVER_WIDTH: f64 = 400.0;
const POPOVER_HEIGHT: f64 = 580.0;

// ─── Tauri commands ─────────────────────────────────────────────────────────

#[tauri::command]
pub fn tray_resolve_permission(
    project_id: String,
    task_id: String,
    chat_id: String,
    option_id: String,
) -> Result<(), String> {
    let session_key = format!("{}:{}:{}", project_id, task_id, chat_id);
    let handle = crate::acp::get_session_handle(&session_key)
        .ok_or_else(|| "session not found or already exited".to_string())?;
    if !handle.respond_permission(option_id) {
        return Err("no pending permission to respond to".to_string());
    }
    Ok(())
}

/// Bring the main Grove window forward. Used by header ↗ button — lands
/// on the Tasks page.
#[tauri::command]
pub fn tray_open_main(app: AppHandle) -> Result<(), String> {
    surface_main(&app);
    let payload = NavigatePayload {
        route: "tasks".into(),
        project_id: None,
        task_id: None,
        chat_id: None,
    };
    let _ = app.emit_to("main", "tray:navigate", &payload);
    record_navigate(payload);
    Ok(())
}

/// Bring the main Grove window forward AND switch to Settings. Used by
/// the header ⚙ button.
#[tauri::command]
pub fn tray_open_settings(app: AppHandle) -> Result<(), String> {
    surface_main(&app);
    let payload = NavigatePayload {
        route: "settings".into(),
        project_id: None,
        task_id: None,
        chat_id: None,
    };
    let _ = app.emit_to("main", "tray:navigate", &payload);
    record_navigate(payload);
    Ok(())
}

/// Bring the main window forward AND navigate to a specific project / task
/// (and optionally chat). Used by per-card Open buttons.
#[tauri::command]
pub fn tray_open_task(
    app: AppHandle,
    project_id: String,
    task_id: String,
    chat_id: Option<String>,
) -> Result<(), String> {
    surface_main(&app);
    let payload = NavigatePayload {
        route: "tasks".into(),
        project_id: Some(project_id),
        task_id: Some(task_id),
        chat_id,
    };
    let _ = app.emit_to("main", "tray:navigate", &payload);
    record_navigate(payload);
    Ok(())
}

/// Drain and return the pending tray:navigate payload (if any). Drops
/// stash entries older than `PENDING_NAVIGATE_TTL_MS` so a delayed mount
/// (e.g. theme switch causing AppContent re-mount hours after the click)
/// doesn't silently replay stale Open clicks.
#[tauri::command]
pub fn tray_take_pending_navigate() -> Option<NavigatePayload> {
    let now = chrono::Utc::now().timestamp_millis();
    PENDING_NAVIGATE.lock().ok().and_then(|mut slot| {
        let entry = slot.take()?;
        let age = now - entry.stashed_at_ms;
        if age < PENDING_NAVIGATE_TTL_MS {
            Some(entry.payload)
        } else {
            // Expired entry dropped silently — log a breadcrumb so users
            // who report "I clicked Open and nothing happened" have a
            // hint in the GUI log.
            eprintln!(
                "[tray] dropping expired pending navigate ({}ms old, TTL {}ms)",
                age, PENDING_NAVIGATE_TTL_MS
            );
            None
        }
    })
}

fn surface_main(app: &AppHandle) {
    if let Some(popover) = app.get_webview_window(POPOVER_LABEL) {
        let _ = popover.hide();
    }
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.unminimize();
        let _ = win.show();
        let _ = win.set_focus();
        #[cfg(target_os = "macos")]
        activate_app_macos();
    }
}

#[cfg(target_os = "macos")]
fn activate_app_macos() {
    // `[NSApp activateIgnoringOtherApps:YES]` — bring the whole Grove app
    // forward across other apps. Tauri's set_focus alone only focuses
    // within the current app.
    use objc2::msg_send;
    use objc2::runtime::{AnyClass, AnyObject, Bool};
    unsafe {
        if let Some(cls) = AnyClass::get("NSApplication") {
            let app: *mut AnyObject = msg_send![cls, sharedApplication];
            if !app.is_null() {
                let _: () = msg_send![app, activateIgnoringOtherApps: Bool::YES];
            }
        }
    }
}

// ─── Popover window ─────────────────────────────────────────────────────────

fn ensure_popover(app: &AppHandle, port: u16) -> tauri::Result<()> {
    if app.get_webview_window(POPOVER_LABEL).is_some() {
        return Ok(());
    }
    // Match the protocol the API server is binding (set by start_server in
    // gui.rs). Currently always http for local-loopback GUI mode but read
    // the env var so HTTPS support won't silently break.
    let protocol = std::env::var("GROVE_PROTOCOL").unwrap_or_else(|_| "http".to_string());
    let url = format!("{}://localhost:{}/tray.html", protocol, port);
    WebviewWindowBuilder::new(
        app,
        POPOVER_LABEL,
        WebviewUrl::External(url.parse().expect("valid popover URL")),
    )
    .title("Grove Notifications")
    .inner_size(POPOVER_WIDTH, POPOVER_HEIGHT)
    .resizable(false)
    .decorations(false)
    .skip_taskbar(true)
    // No `.always_on_top(true)` — when the user clicks Open we want the
    // main window to actually become foreground; an always-on-top popover
    // can shadow that activation on macOS.
    .visible(false)
    .build()?;
    Ok(())
}

fn hide_popover(app: &AppHandle) {
    if let Some(win) = app.get_webview_window(POPOVER_LABEL) {
        let _ = win.hide();
    }
}

fn show_popover_at(app: &AppHandle, anchor: Option<(f64, f64)>) {
    let Some(win) = app.get_webview_window(POPOVER_LABEL) else {
        return;
    };
    if let Some((x, y)) = compute_popover_position(app, anchor) {
        let _ = win.set_position(tauri::PhysicalPosition::new(x, y));
    }
    let _ = win.show();
    let _ = win.set_focus();
}

fn toggle_popover(app: &AppHandle, anchor: Option<(f64, f64)>) {
    if let Some(win) = app.get_webview_window(POPOVER_LABEL) {
        if win.is_visible().unwrap_or(false) {
            let _ = win.hide();
        } else {
            show_popover_at(app, anchor);
        }
    }
}

fn compute_popover_position(app: &AppHandle, anchor: Option<(f64, f64)>) -> Option<(f64, f64)> {
    // Pick the monitor the tray icon is actually on (multi-display setups
    // can have menubar on a non-primary screen). Fall back to primary or
    // first available if anchor isn't usable.
    let monitor = anchor
        .and_then(|(x, y)| app.monitor_from_point(x, y).ok().flatten())
        .or_else(|| app.primary_monitor().ok().flatten())
        .or_else(|| {
            app.available_monitors()
                .ok()
                .and_then(|v| v.into_iter().next())
        })?;
    let scale = monitor.scale_factor();
    let mon_pos = monitor.position();
    let mon_size = monitor.size();
    let popover_w_phys = POPOVER_WIDTH * scale;
    #[cfg(not(target_os = "macos"))]
    let popover_h_phys = POPOVER_HEIGHT * scale;

    #[cfg(target_os = "macos")]
    {
        let (x, y) = if let Some((tx, ty)) = anchor {
            (
                (tx - popover_w_phys / 2.0).max(mon_pos.x as f64 + 8.0),
                ty + 4.0 * scale,
            )
        } else {
            (
                mon_pos.x as f64 + mon_size.width as f64 - popover_w_phys - 8.0 * scale,
                mon_pos.y as f64 + 28.0 * scale,
            )
        };
        Some((x, y))
    }

    #[cfg(target_os = "windows")]
    {
        let _ = anchor;
        let x = mon_pos.x as f64 + mon_size.width as f64 - popover_w_phys - 12.0 * scale;
        let y = mon_pos.y as f64 + mon_size.height as f64 - popover_h_phys - 56.0 * scale;
        Some((x, y))
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = anchor;
        let x = mon_pos.x as f64 + (mon_size.width as f64 - popover_w_phys) / 2.0;
        let y = mon_pos.y as f64 + (mon_size.height as f64 - popover_h_phys) / 2.0;
        Some((x, y))
    }
}

// ─── Init ──────────────────────────────────────────────────────────────────

pub fn init(app: &AppHandle, port: u16) -> tauri::Result<()> {
    let menu = Menu::with_items(
        app,
        &[
            &MenuItem::with_id(app, "tray-show", "Show Notifications", true, None::<&str>)?,
            &MenuItem::with_id(app, "tray-open-main", "Open Grove", true, None::<&str>)?,
            &MenuItem::with_id(app, "tray-quit", "Quit Grove", true, None::<&str>)?,
        ],
    )?;

    let icon = Image::from_bytes(TRAY_ICON_BYTES)?;
    let app_for_menu = app.clone();
    let app_for_click = app.clone();
    let _tray = TrayIconBuilder::with_id("grove-tray")
        .icon(icon)
        .icon_as_template(false)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(move |_app, event: MenuEvent| match event.id().as_ref() {
            "tray-show" => show_popover_at(&app_for_menu, None),
            "tray-open-main" => {
                if let Some(win) = app_for_menu.get_webview_window("main") {
                    let _ = win.show();
                    let _ = win.unminimize();
                    let _ = win.set_focus();
                }
                hide_popover(&app_for_menu);
            }
            "tray-quit" => app_for_menu.exit(0),
            _ => {}
        })
        .on_tray_icon_event(move |tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                rect,
                ..
            } = event
            {
                let scale = tray
                    .app_handle()
                    .primary_monitor()
                    .ok()
                    .flatten()
                    .map(|m| m.scale_factor())
                    .unwrap_or(1.0);
                let pos = rect.position.to_physical::<f64>(scale);
                let size = rect.size.to_physical::<f64>(scale);
                let anchor_x = pos.x + size.width / 2.0;
                let anchor_y = pos.y + size.height;
                toggle_popover(&app_for_click, Some((anchor_x, anchor_y)));
            }
        })
        .build(app)?;

    if let Err(e) = ensure_popover(app, port) {
        eprintln!("[tray] failed to create popover window: {}", e);
    }

    Ok(())
}

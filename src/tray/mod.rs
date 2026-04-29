//! macOS-first menubar tray for Grove.
//!
//! The tray subscribes to the global `RADIO_EVENTS` broadcast and maintains a
//! small in-memory `EventStore` of three event categories — pending
//! permissions, running sessions, and completed turns. A hidden popover
//! webview window renders the store; clicking the tray icon toggles it.
//!
//! State is intentionally **non-persistent**: restarting Grove clears all
//! tray events. This matches user expectations (events are transient) and
//! avoids the bookkeeping cost of a separate "read/unread" persistence layer.

use serde::Serialize;
use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};

use tauri::{
    image::Image,
    menu::{Menu, MenuEvent, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder,
};

use crate::api::handlers::walkie_talkie::{PermissionOptionInfo, RadioEvent};

const TRAY_ICON_BYTES: &[u8] = include_bytes!("../../src-tauri/icons/32x32.png");
const POPOVER_LABEL: &str = "tray-popover";
const POPOVER_WIDTH: f64 = 400.0;
const POPOVER_HEIGHT: f64 = 580.0;
const DONE_CAP: usize = 50;

// ─── EventStore ─────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
pub struct PermissionEvent {
    pub id: String,
    pub project_id: String,
    pub task_id: String,
    pub chat_id: String,
    pub description: String,
    pub options: Vec<PermissionOptionInfo>,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct RunningEvent {
    pub id: String,
    pub project_id: String,
    pub task_id: String,
    pub prompt: Option<String>,
    pub started_at: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct DoneEvent {
    pub id: String,
    pub project_id: String,
    pub task_id: String,
    pub level: Option<String>,
    pub message: Option<String>,
    pub created_at: i64,
}

#[derive(Debug, Default, Clone, Serialize)]
pub struct EventSnapshot {
    pub permissions: Vec<PermissionEvent>,
    pub running: Vec<RunningEvent>,
    pub done: Vec<DoneEvent>,
}

#[derive(Debug, Default)]
struct EventStore {
    /// keyed by chat_id — only one pending permission per chat at a time.
    permissions: HashMap<String, PermissionEvent>,
    /// keyed by (project_id, task_id) — coarse-grained running indicator.
    /// A task is "running" iff any chat under it is busy. Counted by ref so
    /// transitions on multiple chats don't prematurely clear the entry.
    running: HashMap<(String, String), RunningEvent>,
    /// FIFO with cap, newest at front.
    done: VecDeque<DoneEvent>,
}

impl EventStore {
    fn snapshot(&self) -> EventSnapshot {
        let mut permissions: Vec<_> = self.permissions.values().cloned().collect();
        permissions.sort_by_key(|p| std::cmp::Reverse(p.created_at));
        let mut running: Vec<_> = self.running.values().cloned().collect();
        running.sort_by_key(|r| r.started_at);
        let done: Vec<_> = self.done.iter().cloned().collect();
        EventSnapshot {
            permissions,
            running,
            done,
        }
    }

    fn pending_permission_count(&self) -> usize {
        self.permissions.len()
    }
}

#[derive(Clone)]
pub struct TrayState {
    store: Arc<Mutex<EventStore>>,
    app: AppHandle,
}

impl TrayState {
    fn emit_change(&self) {
        let snapshot = self.store.lock().unwrap().snapshot();
        let _ = self.app.emit("tray:events", &snapshot);
        let pending = self.store.lock().unwrap().pending_permission_count();
        update_tray_title(&self.app, pending);
    }
}

// ─── RadioEvent → store mutation ────────────────────────────────────────────

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn apply_event(store: &mut EventStore, event: RadioEvent) -> bool {
    match event {
        RadioEvent::ChatStatus {
            project_id,
            task_id,
            chat_id,
            status,
            permission,
        } => {
            if status == "permission_required" {
                if let Some(p) = permission {
                    let id = format!("perm-{}-{}", chat_id, now_ms());
                    store.permissions.insert(
                        chat_id.clone(),
                        PermissionEvent {
                            id,
                            project_id,
                            task_id,
                            chat_id,
                            description: p.description,
                            options: p.options,
                            created_at: now_ms(),
                        },
                    );
                    return true;
                }
                false
            } else {
                // Any non-pending status clears a stale permission entry.
                store.permissions.remove(&chat_id).is_some()
            }
        }
        RadioEvent::TaskBusy {
            project_id,
            task_id,
            busy,
            prompt,
            started_at,
        } => {
            let key = (project_id.clone(), task_id.clone());
            if busy {
                let id = format!("run-{}-{}", task_id, now_ms());
                store.running.insert(
                    key,
                    RunningEvent {
                        id,
                        project_id,
                        task_id,
                        prompt,
                        started_at: started_at.unwrap_or_else(now_ms),
                    },
                );
                true
            } else {
                store.running.remove(&key).is_some()
            }
        }
        RadioEvent::HookAdded {
            project_id,
            task_id,
            level,
            message,
        } => {
            let id = format!("done-{}-{}", task_id, now_ms());
            if store.done.len() >= DONE_CAP {
                store.done.pop_back();
            }
            store.done.push_front(DoneEvent {
                id,
                project_id,
                task_id,
                level,
                message,
                created_at: now_ms(),
            });
            true
        }
        _ => false,
    }
}

// ─── Tauri commands ─────────────────────────────────────────────────────────

#[tauri::command]
pub fn tray_get_events(state: tauri::State<'_, TrayState>) -> EventSnapshot {
    state.store.lock().unwrap().snapshot()
}

#[tauri::command]
pub fn tray_dismiss(
    state: tauri::State<'_, TrayState>,
    category: String,
    id: String,
) -> Result<(), String> {
    let mut changed = false;
    {
        let mut store = state.store.lock().unwrap();
        match category.as_str() {
            "permission" => {
                let key = store
                    .permissions
                    .iter()
                    .find(|(_, p)| p.id == id)
                    .map(|(k, _)| k.clone());
                if let Some(k) = key {
                    store.permissions.remove(&k);
                    changed = true;
                }
            }
            "running" => {
                let key = store
                    .running
                    .iter()
                    .find(|(_, r)| r.id == id)
                    .map(|(k, _)| k.clone());
                if let Some(k) = key {
                    store.running.remove(&k);
                    changed = true;
                }
            }
            "done" => {
                let before = store.done.len();
                store.done.retain(|d| d.id != id);
                changed = store.done.len() != before;
            }
            _ => return Err(format!("unknown category: {}", category)),
        }
    }
    if changed {
        state.emit_change();
    }
    Ok(())
}

#[tauri::command]
pub fn tray_resolve_permission(
    state: tauri::State<'_, TrayState>,
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
    // Remove from store immediately — the ChatStatus broadcast will follow,
    // but the user expects instant feedback.
    {
        let mut store = state.store.lock().unwrap();
        store.permissions.remove(&chat_id);
    }
    state.emit_change();
    Ok(())
}

#[tauri::command]
pub fn tray_open_main(app: AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_focus();
    }
    hide_popover(&app);
    Ok(())
}

#[tauri::command]
pub fn tray_hide_popover(app: AppHandle) -> Result<(), String> {
    hide_popover(&app);
    Ok(())
}

// ─── Popover window ─────────────────────────────────────────────────────────

fn ensure_popover(app: &AppHandle, port: u16) -> tauri::Result<()> {
    if app.get_webview_window(POPOVER_LABEL).is_some() {
        return Ok(());
    }
    let url = format!("http://localhost:{}/?page=tray-popover", port);
    let builder = WebviewWindowBuilder::new(
        app,
        POPOVER_LABEL,
        WebviewUrl::External(url.parse().expect("valid popover URL")),
    )
    .title("Grove Notifications")
    .inner_size(POPOVER_WIDTH, POPOVER_HEIGHT)
    .resizable(false)
    .decorations(false)
    .skip_taskbar(true)
    .always_on_top(true)
    .visible(false);

    builder.build()?;
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
    let pos = compute_popover_position(app, anchor);
    if let Some((x, y)) = pos {
        let _ = win.set_position(tauri::PhysicalPosition::new(x, y));
    }
    let _ = win.show();
    let _ = win.set_focus();
}

fn toggle_popover(app: &AppHandle, anchor: Option<(f64, f64)>) {
    if let Some(win) = app.get_webview_window(POPOVER_LABEL) {
        let visible = win.is_visible().unwrap_or(false);
        if visible {
            let _ = win.hide();
        } else {
            show_popover_at(app, anchor);
        }
    }
}

/// Compute popover top-left in physical pixels.
///
/// Strategy by platform:
/// - **macOS**: anchor below the tray icon, horizontally centered on the
///   icon, with a small gap. Falls back to top-right of the primary monitor.
/// - **Windows**: bottom-right of the primary monitor (taskbar tray area).
/// - **Linux**: centered on the primary monitor (tray coords are unreliable
///   across desktop environments).
fn compute_popover_position(app: &AppHandle, anchor: Option<(f64, f64)>) -> Option<(f64, f64)> {
    let monitor = app.primary_monitor().ok().flatten().or_else(|| {
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
            // Fallback: top-right corner under menubar
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

// ─── Tray icon registration ─────────────────────────────────────────────────

fn update_tray_title(app: &AppHandle, pending: usize) {
    if let Some(tray) = app.tray_by_id("grove-tray") {
        let title = if pending > 0 {
            format!(" {}", pending)
        } else {
            String::new()
        };
        let _ = tray.set_title(Some(&title));
    }
}

/// Initialize the tray icon, popover, event subscriber, and Tauri state.
///
/// Call from `tauri::Builder::setup`. Idempotent — calling twice is a no-op
/// because Tauri rejects duplicate window/tray IDs.
pub fn init(app: &AppHandle, port: u16) -> tauri::Result<()> {
    let store = Arc::new(Mutex::new(EventStore::default()));
    let state = TrayState {
        store: store.clone(),
        app: app.clone(),
    };
    app.manage(state.clone());

    // Build menu — used as right-click on macOS, primary on Windows/Linux.
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

    // Build popover window upfront (hidden) so first click is fast.
    if let Err(e) = ensure_popover(app, port) {
        eprintln!("[tray] failed to create popover window: {}", e);
    }

    // Spawn event subscriber on the existing tokio runtime.
    let state_for_loop = state.clone();
    tauri::async_runtime::spawn(async move {
        let mut rx = crate::api::handlers::walkie_talkie::subscribe_radio_events();
        loop {
            match rx.recv().await {
                Ok(event) => {
                    let changed = {
                        let mut store = state_for_loop.store.lock().unwrap();
                        apply_event(&mut store, event)
                    };
                    if changed {
                        state_for_loop.emit_change();
                    }
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                    // Dropped events — keep going. On lag the in-memory store
                    // may briefly diverge from truth; the next emission will
                    // bring it back in line.
                    continue;
                }
                Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
            }
        }
    });

    Ok(())
}

//! The mini Buddy: one small floating window for talking to a Buddy while
//! working elsewhere, on top of any app. At most one exists; opening it for
//! another Buddy switches what it shows.
//!
//! Collapsed it is just the avatar (a transparent, always-on-top bubble);
//! expanded it is a compact conversation drawn in the app's own theme. The
//! window is transparent with no native shadow: the page draws the panel,
//! its edge and its shadow inside a margin, and animates growing out of the
//! bubble. Resizing keeps the bottom-right corner (where the bubble sits).

use tauri::{AppHandle, Emitter, LogicalPosition, Manager, WebviewUrl, WebviewWindowBuilder};

const LABEL: &str = "buddy-mini";
// Sizes include the 20px transparent margin the page draws shadows into
// (buddy-mini.css keeps every shadow inside it, or the window edge clips it).
/// The collapsed bubble (60px).
const COLLAPSED: (f64, f64) = (100.0, 100.0);
/// The panel at 380 x 580.
const EXPANDED: (f64, f64) = (420.0, 620.0);
/// The most room a speech bubble beside the collapsed avatar may take.
const PEEK_MAX: (f64, f64) = (340.0, 200.0);
/// The smallest the expanded window can be dragged to.
const MIN_EXPANDED: (f64, f64) = (360.0, 420.0);
/// The size the user last dragged the expanded window to, restored on expand.
static LAST_EXPANDED: std::sync::Mutex<Option<(f64, f64)>> = std::sync::Mutex::new(None);
/// Gap from the screen edges (and the Dock) for the first placement, on top
/// of the page's own margin.
const MARGIN: f64 = 4.0;

/// Open (or switch) the mini Buddy, expanded.
#[tauri::command]
pub fn buddy_mini_open(app: AppHandle, buddy_id: String) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(LABEL) {
        window
            .emit("buddy-mini:show", &buddy_id)
            .map_err(|e| e.to_string())?;
        resize(&window, true);
        let _ = window.show();
        let _ = window.set_focus();
        return Ok(());
    }
    let port = crate::cli::gui::gui_port().ok_or("GUI port is not initialized")?;
    let protocol = std::env::var("GROVE_PROTOCOL").unwrap_or_else(|_| "http".to_string());
    let url = url::Url::parse_with_params(
        &format!("{protocol}://localhost:{port}/buddy-mini.html"),
        [("id", buddy_id.as_str())],
    )
    .map_err(|e| e.to_string())?;
    let mut builder = WebviewWindowBuilder::new(&app, LABEL, WebviewUrl::External(url))
        .title("Buddy")
        .inner_size(EXPANDED.0, EXPANDED.1)
        .resizable(true)
        .min_inner_size(MIN_EXPANDED.0, MIN_EXPANDED.1)
        .decorations(false)
        .shadow(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .visible_on_all_workspaces(true)
        // Needs Tauri's `macos-private-api` (enabled in Cargo.toml) on macOS.
        .transparent(true)
        .disable_drag_drop_handler();
    if let Some((x, y)) = first_position(&app) {
        builder = builder.position(x, y);
    }
    let window = builder.build().map_err(|e| e.to_string())?;
    #[cfg(target_os = "macos")]
    float_over_fullscreen(&window);
    let _ = window.set_focus();
    Ok(())
}

/// Collapse to the avatar bubble or expand to the conversation.
#[tauri::command]
pub fn buddy_mini_set_expanded(app: AppHandle, expanded: bool) -> Result<(), String> {
    let window = app
        .get_webview_window(LABEL)
        .ok_or("Mini Buddy is not open")?;
    resize(&window, expanded);
    if expanded {
        let _ = window.set_focus();
    }
    Ok(())
}

/// While collapsed, make room beside the bubble for a speech bubble (typing
/// dots, a reply, a request) or give it back. The bubble keeps its corner.
#[tauri::command]
pub fn buddy_mini_set_collapsed_size(
    app: AppHandle,
    width: f64,
    height: f64,
) -> Result<(), String> {
    let window = app
        .get_webview_window(LABEL)
        .ok_or("Mini Buddy is not open")?;
    let collapsed = window
        .inner_size()
        .ok()
        .zip(window.scale_factor().ok())
        .is_some_and(|(size, scale)| (size.width as f64 / scale) < MIN_EXPANDED.0);
    if collapsed {
        resize_to(
            &window,
            width.clamp(COLLAPSED.0, PEEK_MAX.0),
            height.clamp(COLLAPSED.1, PEEK_MAX.1),
        );
    }
    Ok(())
}

#[tauri::command]
pub fn buddy_mini_close(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(LABEL) {
        window.close().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Hand the conversation back: the main window comes forward on this Buddy's
/// page and the mini window goes away.
#[tauri::command]
pub fn buddy_mini_open_in_main(app: AppHandle, buddy_id: String) -> Result<(), String> {
    app.emit_to("main", "buddy-mini:open-in-main", &buddy_id)
        .map_err(|e| e.to_string())?;
    super::surface_main(&app)?;
    if let Some(window) = app.get_webview_window(LABEL) {
        let _ = window.close();
    }
    Ok(())
}

/// Bottom-right of the main window's screen, clear of the Dock.
fn first_position(app: &AppHandle) -> Option<(f64, f64)> {
    let monitor = app
        .get_webview_window("main")
        .and_then(|main| main.current_monitor().ok().flatten())
        .or_else(|| app.primary_monitor().ok().flatten())?;
    let scale = monitor.scale_factor();
    let area = monitor.work_area();
    let x = area.position.x as f64 / scale + area.size.width as f64 / scale - EXPANDED.0 - MARGIN;
    let y = area.position.y as f64 / scale + area.size.height as f64 / scale - EXPANDED.1 - MARGIN;
    Some((x, y))
}

fn resize(window: &tauri::WebviewWindow, expanded: bool) {
    let (width, height) = if expanded {
        // Already expanded (opened again for another Buddy): keep its size.
        let open = window
            .inner_size()
            .ok()
            .zip(window.scale_factor().ok())
            .is_some_and(|(size, scale)| size.width as f64 / scale >= MIN_EXPANDED.0);
        if open {
            return;
        }
        last_expanded().unwrap_or(EXPANDED)
    } else {
        // Remember the dragged size; the bubble can't be resized (or held at the minimum).
        if let (Ok(size), Ok(scale)) = (window.inner_size(), window.scale_factor()) {
            let current = (size.width as f64 / scale, size.height as f64 / scale);
            if current.0 >= MIN_EXPANDED.0 && current.1 >= MIN_EXPANDED.1 {
                *LAST_EXPANDED.lock().unwrap_or_else(|e| e.into_inner()) = Some(current);
            }
        }
        let _ = window.set_min_size(None::<tauri::LogicalSize<f64>>);
        let _ = window.set_resizable(false);
        COLLAPSED
    };
    resize_to(window, width, height);
    if expanded {
        let _ = window.set_min_size(Some(tauri::LogicalSize::new(
            MIN_EXPANDED.0,
            MIN_EXPANDED.1,
        )));
        let _ = window.set_resizable(true);
    }
}

fn last_expanded() -> Option<(f64, f64)> {
    *LAST_EXPANDED.lock().unwrap_or_else(|e| e.into_inner())
}

/// Resize at once, keeping the bottom-right corner; the page animates.
fn resize_to(window: &tauri::WebviewWindow, width: f64, height: f64) {
    #[cfg(target_os = "macos")]
    if set_frame(window, width, height) {
        return;
    }
    let (Ok(position), Ok(size), Ok(scale)) = (
        window.outer_position(),
        window.outer_size(),
        window.scale_factor(),
    ) else {
        return;
    };
    let right = (position.x as f64 + size.width as f64) / scale;
    let bottom = (position.y as f64 + size.height as f64) / scale;
    let _ = window.set_size(tauri::LogicalSize::new(width, height));
    let _ = window.set_position(LogicalPosition::new(right - width, bottom - height));
}

#[cfg(target_os = "macos")]
mod cocoa {
    use objc2::encode::{Encode, Encoding};

    #[repr(C)]
    #[derive(Clone, Copy)]
    pub struct Point {
        pub x: f64,
        pub y: f64,
    }
    #[repr(C)]
    #[derive(Clone, Copy)]
    pub struct Size {
        pub width: f64,
        pub height: f64,
    }
    #[repr(C)]
    #[derive(Clone, Copy)]
    pub struct Rect {
        pub origin: Point,
        pub size: Size,
    }
    unsafe impl Encode for Point {
        const ENCODING: Encoding = Encoding::Struct("CGPoint", &[f64::ENCODING, f64::ENCODING]);
    }
    unsafe impl Encode for Size {
        const ENCODING: Encoding = Encoding::Struct("CGSize", &[f64::ENCODING, f64::ENCODING]);
    }
    unsafe impl Encode for Rect {
        const ENCODING: Encoding = Encoding::Struct("CGRect", &[Point::ENCODING, Size::ENCODING]);
    }
}

/// Size and place the window in one step (no flash between the two). Cocoa
/// frames start at the bottom-left, so keeping the bottom-right corner only
/// moves `x`.
#[cfg(target_os = "macos")]
fn set_frame(window: &tauri::WebviewWindow, width: f64, height: f64) -> bool {
    use objc2::msg_send;
    use objc2::runtime::{AnyObject, Bool};
    let Ok(pointer) = window.ns_window() else {
        return false;
    };
    if pointer.is_null() {
        return false;
    }
    let ns_window = pointer as *mut AnyObject;
    unsafe {
        let frame: cocoa::Rect = msg_send![ns_window, frame];
        let next = cocoa::Rect {
            origin: cocoa::Point {
                x: frame.origin.x + frame.size.width - width,
                y: frame.origin.y,
            },
            size: cocoa::Size { width, height },
        };
        let _: () = msg_send![ns_window, setFrame: next, display: Bool::YES, animate: Bool::NO];
    }
    true
}

/// Stay visible over full-screen apps and on every Space, like a system HUD.
#[cfg(target_os = "macos")]
fn float_over_fullscreen(window: &tauri::WebviewWindow) {
    use objc2::msg_send;
    use objc2::runtime::AnyObject;
    // NSWindowCollectionBehavior: CanJoinAllSpaces | Stationary | FullScreenAuxiliary.
    const BEHAVIOR: usize = (1 << 0) | (1 << 4) | (1 << 8);
    let Ok(pointer) = window.ns_window() else {
        return;
    };
    if pointer.is_null() {
        return;
    }
    unsafe {
        let _: () = msg_send![pointer as *mut AnyObject, setCollectionBehavior: BEHAVIOR];
    }
}

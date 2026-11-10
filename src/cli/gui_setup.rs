//! First-run setup in the desktop app: the main window opens small, as a
//! setup window of its own, and grows into its usual size when setup ends
//! (finished or skipped). The page inside is the same one a browser shows.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use tauri::{AppHandle, LogicalSize, Manager, WebviewWindow};

/// Wide enough that the page keeps its desktop layout (it turns to the phone
/// one below 768), and within the main window's own minimum size (see `gui.rs`).
const WIDTH: f64 = 800.0;
const HEIGHT: f64 = 600.0;

static COMPACT: AtomicBool = AtomicBool::new(false);
/// The window's size before it was made small, in logical pixels.
static USUAL_SIZE: Mutex<Option<(f64, f64)>> = Mutex::new(None);

/// Whether this start opens on first-run setup. The same conditions as the
/// page (`OrbitWelcome`), read once the backend is ready; if the two ever
/// disagree the page asks for `setup_window_end` and the window grows.
fn setup_pending() -> bool {
    let config = crate::storage::config::load_config();
    !config.web.setup_done
        && config.web.interface.as_deref() == Some("orbit")
        && crate::storage::workspace::load_projects()
            .map(|projects| projects.is_empty())
            .unwrap_or(false)
}

/// Call right before the main window is first shown, on the main thread.
pub fn prepare(window: &WebviewWindow, remote: bool) {
    if remote || !setup_pending() {
        return;
    }
    let usual = match (window.inner_size(), window.scale_factor()) {
        (Ok(size), Ok(scale)) if scale > 0.0 => {
            (size.width as f64 / scale, size.height as f64 / scale)
        }
        _ => return,
    };
    *USUAL_SIZE.lock().unwrap_or_else(|e| e.into_inner()) = Some(usual);
    resize_around_center(window, (WIDTH, HEIGHT), false);
    let _ = window.set_resizable(false);
    COMPACT.store(true, Ordering::SeqCst);
}

/// Setup is over, or the page is not showing it: give the main window its usual size back.
#[tauri::command]
pub fn setup_window_end(app: AppHandle) {
    if !COMPACT.swap(false, Ordering::SeqCst) {
        return;
    }
    let Some(usual) = USUAL_SIZE.lock().unwrap_or_else(|e| e.into_inner()).take() else {
        return;
    };
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        let Some(window) = handle.get_webview_window("main") else {
            return;
        };
        let _ = window.set_resizable(true);
        resize_around_center(&window, usual, true);
    });
}

/// Resize the window around its own center, in one step so it never shows
/// at the new size in the old place. `animate` lets the system animate it.
#[cfg(target_os = "macos")]
fn resize_around_center(window: &WebviewWindow, (width, height): (f64, f64), animate: bool) {
    use crate::tray::buddy_mini::cocoa::{Point, Rect, Size};
    use objc2::msg_send;
    use objc2::runtime::{AnyObject, Bool};
    let ns_window = match window.ns_window() {
        Ok(pointer) if !pointer.is_null() => pointer as *mut AnyObject,
        _ => {
            let _ = window.set_size(LogicalSize::new(width, height));
            return;
        }
    };
    unsafe {
        let frame: Rect = msg_send![ns_window, frame];
        let mut next = Rect {
            origin: Point {
                x: frame.origin.x - (width - frame.size.width) / 2.0,
                y: frame.origin.y - (height - frame.size.height) / 2.0,
            },
            size: Size { width, height },
        };
        // Keep it on its screen, below the menu bar and clear of the Dock.
        let screen: *mut AnyObject = msg_send![ns_window, screen];
        if !screen.is_null() {
            let visible: Rect = msg_send![screen, visibleFrame];
            next.size.width = next.size.width.min(visible.size.width);
            next.size.height = next.size.height.min(visible.size.height);
            next.origin.x = next.origin.x.clamp(
                visible.origin.x,
                visible.origin.x + visible.size.width - next.size.width,
            );
            next.origin.y = next.origin.y.clamp(
                visible.origin.y,
                visible.origin.y + visible.size.height - next.size.height,
            );
        }
        let _: () =
            msg_send![ns_window, setFrame: next, display: Bool::YES, animate: Bool::new(animate)];
    }
}

#[cfg(not(target_os = "macos"))]
fn resize_around_center(window: &WebviewWindow, (width, height): (f64, f64), _animate: bool) {
    let before = match (
        window.outer_position(),
        window.outer_size(),
        window.scale_factor(),
    ) {
        (Ok(position), Ok(size), Ok(scale)) if scale > 0.0 => Some((
            position.x as f64 / scale + size.width as f64 / scale / 2.0,
            position.y as f64 / scale + size.height as f64 / scale / 2.0,
        )),
        _ => None,
    };
    let _ = window.set_size(LogicalSize::new(width, height));
    if let Some((center_x, center_y)) = before {
        let _ = window.set_position(tauri::LogicalPosition::new(
            (center_x - width / 2.0).max(0.0),
            (center_y - height / 2.0).max(0.0),
        ));
    }
}

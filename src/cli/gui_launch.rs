//! The launch window: on every GUI start the Grove mark floats over the
//! desktop in a transparent, borderless, always-on-top window (`launch.html`)
//! while the main window loads hidden behind it. When the page's animation
//! ends (or the user skips it) it calls `launch_reveal`, which fades the main
//! window in and lets the launch window linger just long enough for its
//! dissolve and the hum's tail before it is destroyed.

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

const LABEL: &str = "launch";
/// Square, with room for the aura's blur and the ring so neither meets the edge.
const SIZE: f64 = 640.0;
/// Show the main window anyway if the page never reports (failed to load, JS error).
const FALLBACK: Duration = Duration::from_secs(6);
/// How long the launch window stays (click-through) after the reveal.
const LINGER: Duration = Duration::from_millis(1600);

static REVEALED: AtomicBool = AtomicBool::new(false);

/// Open the launch window. `false` means it could not be created and the
/// caller should show the main window itself.
///
/// The page is served by this process's embedded assets in remote mode too
/// (only `/api` is proxied). `remote` tells it not to read the appearance
/// config: that lives on the remote backend and needs a sign-in first.
pub fn open(app: &AppHandle, base_url: &str, remote: bool) -> bool {
    let query = if remote { "?remote=1" } else { "" };
    let Ok(url) = format!("{base_url}/launch.html{query}").parse() else {
        return false;
    };
    let built = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::External(url))
        .title("Grove")
        .inner_size(SIZE, SIZE)
        .center()
        .resizable(false)
        .decorations(false)
        .shadow(false)
        .always_on_top(true)
        .skip_taskbar(true)
        // Needs Tauri's `macos-private-api` (enabled in Cargo.toml) on macOS.
        .transparent(true)
        .disable_drag_drop_handler()
        .build();
    if let Err(e) = built {
        eprintln!("[Grove] failed to open launch window: {e}");
        return false;
    }
    let handle = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(FALLBACK);
        reveal(&handle);
    });
    true
}

/// The launch page is done (or was skipped): bring in the main window.
#[tauri::command]
pub fn launch_reveal(app: AppHandle) {
    reveal(&app);
}

fn reveal(app: &AppHandle) {
    if REVEALED.swap(true, Ordering::SeqCst) {
        return;
    }
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        if let Some(main) = handle.get_webview_window("main") {
            #[cfg(target_os = "macos")]
            fade_in(&main);
            #[cfg(not(target_os = "macos"))]
            let _ = main.show();
            let _ = main.set_focus();
        }
        // The page is dissolving over the main window; let clicks through.
        if let Some(launch) = handle.get_webview_window(LABEL) {
            let _ = launch.set_ignore_cursor_events(true);
        }
    });
    let handle = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(LINGER);
        if let Some(launch) = handle.get_webview_window(LABEL) {
            // `destroy`, not `close`: the macOS close handler would only hide it.
            let _ = launch.destroy();
        }
    });
}

/// Show the window at zero alpha and animate it in, so it settles in behind
/// the dissolving mark instead of popping.
#[cfg(target_os = "macos")]
fn fade_in(window: &tauri::WebviewWindow) {
    use objc2::msg_send;
    use objc2::runtime::{AnyClass, AnyObject};
    let ns_window = match window.ns_window() {
        Ok(pointer) if !pointer.is_null() => pointer as *mut AnyObject,
        _ => {
            let _ = window.show();
            return;
        }
    };
    let Some(context_class) = AnyClass::get("NSAnimationContext") else {
        let _ = window.show();
        return;
    };
    unsafe {
        let _: () = msg_send![ns_window, setAlphaValue: 0.0f64];
        let _ = window.show();
        let _: () = msg_send![context_class, beginGrouping];
        let context: *mut AnyObject = msg_send![context_class, currentContext];
        let _: () = msg_send![context, setDuration: 0.5f64];
        let animator: *mut AnyObject = msg_send![ns_window, animator];
        let _: () = msg_send![animator, setAlphaValue: 1.0f64];
        let _: () = msg_send![context_class, endGrouping];
    }
}

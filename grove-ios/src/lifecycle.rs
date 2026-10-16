//! Native lifecycle notifications do not depend on the loopback server working.
pub fn record(stage: &str, port: u16) {
    eprintln!("[iOS transport] {stage} port={port}");
    #[cfg(target_os = "ios")]
    if let Ok(message) = std::ffi::CString::new(format!("{stage} port={port}")) {
        extern "C" {
            fn grove_transport_log(message: *const std::ffi::c_char);
        }
        unsafe {
            grove_transport_log(message.as_ptr());
        }
    }
}

#[cfg(all(feature = "app", target_os = "ios"))]
pub fn install(app: tauri::AppHandle, transport: crate::server::ClientTransport) {
    use std::sync::OnceLock;
    use tauri::Manager;
    use tokio::sync::watch;
    static EVENTS: OnceLock<watch::Sender<(u64, bool)>> = OnceLock::new();
    extern "C" fn changed(active: bool) {
        if let Some(events) = EVENTS.get() {
            events.send_modify(|state| {
                state.0 += 1;
                state.1 = active;
            });
        }
    }
    let (events, mut receiver) = watch::channel((0_u64, true));
    if EVENTS.set(events).is_err() {
        return;
    }
    tauri::async_runtime::spawn(async move {
        while receiver.changed().await.is_ok() {
            let (generation, active) = *receiver.borrow_and_update();
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.eval("window.__GROVE_TRANSPORT_READY__=false;");
            }
            record(if active { "foreground" } else { "background" }, 0);
            let result = transport.set_foreground(active).await;
            // A newer native notification supersedes any in-flight rebuild.
            if *receiver.borrow() != (generation, active) {
                continue;
            }
            if let Err(error) = result {
                record(&format!("recovery_failed: {error}"), 0);
                if let Some(window) = app.get_webview_window("main") {
                    let _ =
                        window.eval("window.dispatchEvent(new Event('grove:transport-failed'));");
                }
            } else if active {
                record("foreground_ready", 0);
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.eval("window.__GROVE_TRANSPORT_READY__=true;window.dispatchEvent(new Event('grove:transport-ready'));window.dispatchEvent(new Event('online'));");
                }
            }
        }
    });
    extern "C" {
        fn grove_transport_observe(callback: extern "C" fn(bool));
    }
    unsafe {
        grove_transport_observe(changed);
    }
}

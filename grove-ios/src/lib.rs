mod activity;
mod lifecycle;
pub mod server;

#[cfg(feature = "app")]
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    use tauri::Manager;

    tauri::Builder::default()
        .setup(|app| {
            let preferences = app.path().app_data_dir()?.join("server.txt");
            let transport = tauri::async_runtime::block_on(server::start(preferences))?;
            app.manage(transport.clone());
            let address = transport.address;
            let origin = format!("http://{address}");
            tauri::WebviewWindowBuilder::new(
                app,
                "main",
                tauri::WebviewUrl::External(format!("{origin}/_grove/").parse()?),
            )
            .title("Grove")
            .initialization_script(
                "window.__GROVE_IOS__ = true;window.__GROVE_TRANSPORT_READY__ = true;",
            )
            // The connected UI needs no native IPC. Keep navigation inside
            // our local client; external content never gets a native bridge.
            .on_navigation({
                let transport = transport.clone();
                move |url| transport.allows_navigation(url)
            })
            .build()?;
            #[cfg(target_os = "ios")]
            lifecycle::install(app.handle().clone(), transport);
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("could not run Grove iOS")
        .run(|app, event| {
            #[cfg(target_os = "ios")]
            if let tauri::RunEvent::Opened { urls } = event {
                for url in urls {
                    let transport = app.state::<server::ClientTransport>().inner().clone();
                    let handle = app.clone();
                    tauri::async_runtime::spawn(async move {
                        if let Some(target) = transport.activity_target(&url).await {
                            if let Some(window) = handle.get_webview_window("main") {
                                let script = window.url().ok().and_then(|current| {
                                    server::activity_navigation_script(&current, &target)
                                });
                                if let Some(script) = script {
                                    let _ = window.eval(&script);
                                } else {
                                    let _ = window.navigate(target);
                                }
                            }
                        }
                    });
                }
            }
            #[cfg(not(target_os = "ios"))]
            let _ = (app, event);
        });
}

//! Narrow native ActivityKit bridge; no remote Tauri IPC is exposed.
pub fn send(value: serde_json::Value) {
    #[cfg(target_os = "ios")]
    {
        extern "C" {
            fn grove_activity_update(json: *const std::ffi::c_char);
        }
        if let Ok(json) = std::ffi::CString::new(value.to_string()) {
            unsafe {
                grove_activity_update(json.as_ptr());
            }
        }
    }
    #[cfg(not(target_os = "ios"))]
    let _ = value;
}
